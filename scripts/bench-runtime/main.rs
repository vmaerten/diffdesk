// Throwaway HTTP/1.1 GET benchmark, not a production HTTP implementation.
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::thread;

fn serve(mut stream: TcpStream) -> std::io::Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let path = line.split_whitespace().nth(1).unwrap_or("").to_owned();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" {
            break;
        }
    }
    let result = match path.as_str() {
        "/health" => Ok(b"{\"ok\":true}\n".to_vec()),
        "/" => fs::read(env::var("BENCH_INDEX").unwrap()),
        "/asset" => fs::read(env::var("BENCH_ASSET").unwrap()),
        "/diff" => Command::new("git")
            .args([
                "-C",
                &env::var("BENCH_REPO").unwrap(),
                "diff",
                "--no-ext-diff",
                "--no-color",
                "HEAD",
            ])
            .output()
            .and_then(|out| {
                if out.status.success() {
                    Ok(out.stdout)
                } else {
                    Err(std::io::Error::other(
                        String::from_utf8_lossy(&out.stderr).to_string(),
                    ))
                }
            }),
        _ => Err(std::io::Error::other("unknown route")),
    };
    let (status, body) = match result {
        Ok(body) => ("200 OK", body),
        Err(err) => ("500 Internal Server Error", err.to_string().into_bytes()),
    };
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(&body)
}

fn main() -> std::io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    println!("{}", listener.local_addr()?.port());
    std::io::stdout().flush()?;
    for stream in listener.incoming() {
        let stream = stream?;
        thread::spawn(move || {
            if let Err(err) = serve(stream) {
                eprintln!("{err}");
            }
        });
    }
    Ok(())
}
