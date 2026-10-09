use axum::{
    body::Body,
    extract::Query,
    http::{header, HeaderValue, Request, Response, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use reqwest::Client;
use include_dir::{include_dir, Dir};

static PROJECT_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../src");

static HTTP: std::sync::LazyLock<Client> = std::sync::LazyLock::new(|| {
    let builder = Client::builder();
    #[cfg(target_os = "android")]
    let builder = builder.tls_certs_only(
        webpki_root_certs::TLS_SERVER_ROOT_CERTS
            .iter()
            .filter_map(|c| reqwest::Certificate::from_der(c).ok()),
    );
    builder.build().expect("failed to build HTTP client")
});

#[derive(serde::Deserialize)]
struct ResolveQuery {
    url: String,
}

// InnerTube "ANDROID" client: its player response carries plain stream URLs (no signature
// deciphering), and the muxed formats download in full without a PO token.
const YT_CLIENT_NAME: &str = "ANDROID";
const YT_CLIENT_ID: &str = "3";
const YT_CLIENT_VERSION: &str = "20.10.38";
const YT_USER_AGENT: &str = "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip";

fn youtube_id(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw).ok()?;
    let host = url.host_str()?.trim_start_matches("www.").trim_start_matches("m.");
    let id = if host == "youtu.be" {
        url.path_segments()?.next()?.to_string()
    } else if host.ends_with("youtube.com") {
        match url.path_segments()?.collect::<Vec<_>>().as_slice() {
            ["watch"] => url.query_pairs().find(|(k, _)| k == "v")?.1.into_owned(),
            ["shorts" | "embed" | "live" | "v", id, ..] => id.to_string(),
            _ => return None,
        }
    } else {
        return None;
    };
    (id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).then_some(id)
}

async fn youtube_player(id: &str) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "context": { "client": {
            "clientName": YT_CLIENT_NAME,
            "clientVersion": YT_CLIENT_VERSION,
            "androidSdkVersion": 34,
            "osName": "Android",
            "osVersion": "14",
            "hl": "en",
        }},
        "videoId": id,
        "contentCheckOk": true,
        "racyCheckOk": true,
    });
    let res = HTTP
        .post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::USER_AGENT, YT_USER_AGENT)
        .header("X-YouTube-Client-Name", YT_CLIENT_ID)
        .header("X-YouTube-Client-Version", YT_CLIENT_VERSION)
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn json_error(status: StatusCode, msg: impl std::fmt::Display) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({ "error": msg.to_string() }).to_string()))
        .unwrap()
}

async fn resolve_handler(Query(query): Query<ResolveQuery>) -> impl IntoResponse {
    let Some(id) = youtube_id(&query.url) else {
        return json_error(StatusCode::BAD_REQUEST, "not a YouTube video URL");
    };
    let player = match youtube_player(&id).await {
        Ok(p) => p,
        Err(e) => return json_error(StatusCode::BAD_GATEWAY, format!("YouTube request failed: {e}")),
    };

    let playability = &player["playabilityStatus"];
    if playability["status"].as_str() != Some("OK") {
        let reason = playability["reason"].as_str().unwrap_or("video is unavailable");
        return json_error(StatusCode::BAD_GATEWAY, format!("YouTube: {reason}"));
    }

    // Highest-resolution muxed (video + audio) format with a direct URL.
    let best = player["streamingData"]["formats"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| f["url"].is_string() && f["mimeType"].as_str().is_some_and(|m| m.starts_with("video/")))
        .max_by_key(|f| f["height"].as_u64().unwrap_or(0));
    let Some(best) = best else {
        return json_error(StatusCode::BAD_GATEWAY, "YouTube returned no downloadable video+audio stream");
    };
    let ext = if best["mimeType"].as_str().is_some_and(|m| m.starts_with("video/webm")) { "webm" } else { "mp4" };

    let captions: Vec<_> = player["captions"]["playerCaptionsTracklistRenderer"]["captionTracks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let url = t["baseUrl"].as_str()?;
            let name = t["name"]["runs"][0]["text"].as_str().or(t["name"]["simpleText"].as_str()).unwrap_or("Captions");
            Some(serde_json::json!({
                "name": name,
                "lang": t["languageCode"].as_str().unwrap_or(""),
                "url": format!("{url}&fmt=json3"),
                "ext": "json3",
            }))
        })
        .collect();

    let result = serde_json::json!({
        "title": player["videoDetails"]["title"],
        "video": {
            "url": best["url"],
            "size": best["contentLength"].as_str().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0),
            "ext": ext,
        },
        "captions": captions,
    });

    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(result.to_string()))
        .unwrap()
}

#[derive(serde::Deserialize)]
struct FetchQuery {
    url: String,
}

async fn fetch_handler(req: Request<Body>) -> impl IntoResponse {
    let fetch_query: Result<Query<FetchQuery>, _> = axum::extract::Query::try_from_uri(req.uri());
    
    let target_url = match fetch_query {
        Ok(q) => q.url.clone(),
        Err(_) => return Response::builder().status(400).body(Body::from("missing url")).unwrap(),
    };

    let mut req_builder = HTTP.get(&target_url);

    // Forward Range header if present
    if let Some(range) = req.headers().get(header::RANGE) {
        req_builder = req_builder.header(header::RANGE, range);
    }

    match req_builder.send().await {
        Ok(res) => {
            let mut builder = Response::builder().status(res.status());
            for (k, v) in res.headers() {
                builder = builder.header(k.clone(), v.clone());
            }
            // Use reqwest stream body converted to axum body
            let stream = res.bytes_stream();
            let body = Body::from_stream(stream);
            builder.body(body).unwrap()
        }
        Err(e) => Response::builder().status(502).body(Body::from(e.to_string())).unwrap(),
    }
}

async fn static_handler(req: Request<Body>) -> impl IntoResponse {
    let mut path = req.uri().path().trim_start_matches('/');
    if path.is_empty() {
        path = "index.html";
    }
    match PROJECT_DIR.get_file(path) {
        Some(file) => {
            let mime_type = mime_guess::from_path(path).first_or_octet_stream();
            Response::builder()
                .header(header::CONTENT_TYPE, mime_type.as_ref())
                .body(Body::from(file.contents()))
                .unwrap()
        }
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap(),
    }
}

pub async fn start_server(listener: tokio::net::TcpListener) {
    let app = Router::new()
        .route("/api/resolve", get(resolve_handler))
        .route("/api/fetch", get(fetch_handler))
        .fallback(static_handler)
        .layer(tower_http::set_header::SetResponseHeaderLayer::overriding(
            header::HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(tower_http::set_header::SetResponseHeaderLayer::overriding(
            header::HeaderName::from_static("cross-origin-embedder-policy"),
            HeaderValue::from_static("require-corp"),
        ));

    axum::serve(listener, app).await.unwrap();
}
