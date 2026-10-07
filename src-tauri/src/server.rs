use axum::{
    body::Body,
    extract::Query,
    http::{header, HeaderValue, Request, Response, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use reqwest::Client;
use rusty_ytdl::{Video, VideoOptions, VideoSearchOptions, VideoQuality};
use include_dir::{include_dir, Dir};

static PROJECT_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../src");

#[derive(serde::Deserialize)]
struct ResolveQuery {
    url: String,
}

async fn resolve_handler(Query(query): Query<ResolveQuery>) -> impl IntoResponse {
    let video_options = VideoOptions {
        quality: VideoQuality::Highest,
        filter: VideoSearchOptions::VideoAudio,
        ..Default::default()
    };
    let video = match Video::new_with_options(&query.url, video_options) {
        Ok(v) => v,
        Err(e) => return Response::builder().status(400).body(Body::from(e.to_string())).unwrap(),
    };
    let info = match video.get_info().await {
        Ok(i) => i,
        Err(e) => return Response::builder().status(500).body(Body::from(e.to_string())).unwrap(),
    };

    let best_format = info.formats.into_iter().find(|f| f.has_video && f.has_audio);
    
    // We mock the yt-dlp output format expected by the frontend:
    let result = serde_json::json!({
        "title": info.video_details.title,
        "video": {
            "url": best_format.as_ref().map(|f| &f.url).unwrap_or(&"".to_string()),
            "size": 0, // frontend doesn't strictly need accurate size if it's 0 it skips progress limit
            "ext": "mp4" // simplify
        },
        "captions": []
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

    let client = Client::new();
    let mut req_builder = client.get(&target_url);

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

pub async fn start_server(port: u16) {
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

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
