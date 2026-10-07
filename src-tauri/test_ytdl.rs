#[tokio::main]
async fn main() {
    let video = rusty_ytdl::Video::new("https://www.youtube.com/watch?v=_-kdV-eHhfg").unwrap();
    let info = video.get_info().await.unwrap();
    println!("{:?}", info.video_details.title);
    for format in info.formats {
        println!("{:?} {:?} {:?}", format.mime_type, format.has_video, format.has_audio);
    }
}
