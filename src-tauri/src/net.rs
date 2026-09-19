//! 统一 HTTP 下载器（唯一实现）
//!
//! 覆盖范围：GitHub release 资产（模型 `tar.bz2`、框架 zip、附加文件如 vocoder）。
//! HuggingFace 走 Python 侧（归属见 docs「推理引擎架构重构方案」§4.6.1），不在此处。
//!
//! 行为契约（所有调用点共用同一实现，故逐项一致）：
//! - **流式落盘**：64KB 块边读边写，不整包进内存
//! - **断点续传**：写 `<dest>.part`；已存在则带 `Range` 续；服务器不支持（返 200）→ 截断重下；
//!   服务器返 416（`.part` 已超出目标长度）→ 删 `.part` 重下
//! - **原子完成**：读完后 `rename(.part → dest)`（同目录同卷），`dest` 已存在且非空则直接跳过
//! - **重试**：连接 / 超时 / 读错 / 408 / 429 / 5xx 视为瞬时错误，最多 3 次（0.5s、1s 退避）；
//!   续传让重试从断点继续而非从头
//! - **取消**：每块检查 `AtomicBool`；取消返回 [`CANCELLED`]，**保留 `.part`**（下次可续）
//! - **进度**：500ms 节流回调 `(已下载, 总大小)`；总大小未知时为 `None`；完成时补一次终值
//!
//! 不做 ETag / 校验和校验：调用方只对**不可变**的 release 资产使用（换版本即换 URL）。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// 取消哨兵：与既有调用方约定一致（`run_download` 识别该串判定为用户取消）
pub const CANCELLED: &str = "__CANCELLED__";

const CHUNK: usize = 64 * 1024;
const THROTTLE: Duration = Duration::from_millis(500);
const MAX_ATTEMPTS: usize = 3;

/// 一次下载的参数
pub struct Download<'a> {
    pub url: &'a str,
    /// 最终落盘路径（实际写 `<dest>.part`，完成后 rename）
    pub dest: &'a Path,
    /// 进度回调（已节流；`None` 总大小 = 服务器未给 Content-Length）
    pub on_progress: Option<&'a dyn Fn(u64, Option<u64>)>,
    pub cancel: Option<&'a AtomicBool>,
    /// 附加请求头（如 HF token；调用方负责只在需要的 host 上带）
    pub headers: &'a [(&'a str, String)],
}

/// 失败分类：决定是否重试
enum Fail {
    Cancelled,
    /// 重试无意义（4xx / 本地写盘失败）
    Fatal(String),
    /// 可重试（网络类 + 5xx/408/429）
    Transient(String),
}

/// `<dest>.part` 路径（同目录 → rename 同卷原子）
pub fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_os_string();
    s.push(".part");
    PathBuf::from(s)
}

/// URL 末段的归档扩展名（`"tar.bz2"` / `"zip"` / `"bin"`）
///
/// 归档落盘命名与 `extract_archive` 的解压分派共用同一判定。
pub fn url_suffix(url: &str) -> &'static str {
    let file = url.rsplit('/').next().unwrap_or(url).to_lowercase();
    for (ext, name) in [
        (".tar.bz2", "tar.bz2"),
        (".tar.gz", "tar.gz"),
        (".tgz", "tgz"),
        (".zip", "zip"),
        (".tar", "tar"),
    ] {
        if file.ends_with(ext) {
            return name;
        }
    }
    "bin"
}

/// 下载到 `dest`；返回最终字节数。失败返回可读错误（取消为 [`CANCELLED`]）。
pub fn download(client: &reqwest::blocking::Client, d: &Download<'_>) -> Result<u64, String> {
    // 已完整落盘（调用方负责用完后删除）：直接复用，天然支持"解压失败后重跑不重下"
    if let Ok(md) = std::fs::metadata(d.dest) {
        if md.is_file() && md.len() > 0 {
            return Ok(md.len());
        }
    }
    if let Some(parent) = d.dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create dir {}: {e}", parent.display()))?;
    }
    let part = part_path(d.dest);
    let mut attempt = 0usize;
    loop {
        attempt += 1;
        match fetch_once(client, d, &part) {
            Ok(n) => {
                std::fs::rename(&part, d.dest)
                    .map_err(|e| format!("rename {} -> {}: {e}", part.display(), d.dest.display()))?;
                if let Some(cb) = d.on_progress {
                    cb(n, Some(n));
                }
                return Ok(n);
            }
            Err(Fail::Cancelled) => return Err(CANCELLED.to_string()),
            Err(Fail::Fatal(msg)) => return Err(msg),
            Err(Fail::Transient(msg)) => {
                if attempt >= MAX_ATTEMPTS {
                    return Err(format!("{msg}（已重试 {attempt} 次）"));
                }
                log::warn!("[net] 下载中断（第 {attempt}/{MAX_ATTEMPTS} 次），从断点重试: {msg}");
                std::thread::sleep(Duration::from_millis(500u64 << (attempt - 1)));
            }
        }
    }
}

/// 单次 HTTP 请求：支持从 `.part` 续传；成功返回累计字节数（含续传部分）
fn fetch_once(
    client: &reqwest::blocking::Client,
    d: &Download<'_>,
    part: &Path,
) -> Result<u64, Fail> {
    let existing = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    let mut req = client.get(d.url);
    for (k, v) in d.headers {
        req = req.header(*k, v.as_str());
    }
    if existing > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={existing}-"));
    }
    let mut resp = req.send().map_err(classify_reqwest)?;
    let status = resp.status();

    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && existing > 0 {
        // `.part` 比目标还长（版本变更/上次中断留下的脏数据）→ 丢弃后重试
        let _ = std::fs::remove_file(part);
        return Err(Fail::Transient(format!(
            "HTTP 416，已丢弃残留分片重下: {}",
            d.url
        )));
    }
    if !status.is_success() {
        return Err(classify_status(status, d.url));
    }

    let resuming = existing > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
    let start = if resuming { existing } else { 0 };
    let body_len = resp.content_length().unwrap_or(0);
    let total = if body_len > 0 {
        Some(start + body_len)
    } else {
        None
    };
    // 日志：与旧实现一致地暴露"本次是从头还是续传"
    log::info!(
        "[net] {} {}（{:.1} MB）",
        if resuming { "续传" } else { "下载" },
        d.url.rsplit('/').next().unwrap_or(d.url),
        body_len as f64 / 1024.0 / 1024.0
    );

    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).write(true);
    if resuming {
        opts.append(true);
    } else {
        opts.truncate(true);
    }
    let mut file = opts
        .open(part)
        .map_err(|e| Fail::Fatal(format!("open {}: {e}", part.display())))?;

    let mut done = start;
    let mut buf = vec![0u8; CHUNK];
    let mut last = Instant::now();
    if let Some(cb) = d.on_progress {
        cb(done, total);
    }
    loop {
        if let Some(c) = d.cancel {
            if c.load(Ordering::Relaxed) {
                return Err(Fail::Cancelled);
            }
        }
        let n = resp.read(&mut buf).map_err(|e| Fail::Transient(format!("read: {e}")))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| Fail::Fatal(format!("write: {e}")))?;
        done += n as u64;
        if last.elapsed() >= THROTTLE {
            if let Some(cb) = d.on_progress {
                cb(done, total);
            }
            last = Instant::now();
        }
    }
    file.flush().map_err(|e| Fail::Fatal(format!("flush: {e}")))?;
    Ok(done)
}

fn classify_reqwest(e: reqwest::Error) -> Fail {
    if e.is_timeout() || e.is_connect() || e.is_body() || e.is_decode() || e.is_request() {
        Fail::Transient(e.to_string())
    } else {
        Fail::Fatal(e.to_string())
    }
}

fn classify_status(status: reqwest::StatusCode, url: &str) -> Fail {
    let transient = status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error();
    let msg = format!("HTTP {status} from {url}");
    if transient {
        Fail::Transient(msg)
    } else {
        Fail::Fatal(msg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use parking_lot::Mutex;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    /// 极简 HTTP 服务器（测试用）：支持 Range / 可指定首发失败次数 / 可分块慢发
    struct ServerCfg {
        body: Vec<u8>,
        support_range: bool,
        /// 前 N 次请求返回 503（测重试）
        fail_first: usize,
        /// 每次写块的间隔（毫秒；用于让下载足够慢以便测试取消）
        chunk_delay_ms: u64,
    }

    struct Server {
        url: String,
        /// 仅 host:port（用于当作代理地址）
        base: String,
        hits: Arc<AtomicUsize>,
        range_hits: Arc<AtomicUsize>,
        stop: Arc<AtomicBool>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
        }
    }

    fn spawn(cfg: ServerCfg) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        listener.set_nonblocking(true).expect("nonblocking");
        let hits = Arc::new(AtomicUsize::new(0));
        let range_hits = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (h2, r2, s2) = (hits.clone(), range_hits.clone(), stop.clone());
        std::thread::spawn(move || {
            while !s2.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((sock, _)) => {
                        let n = h2.fetch_add(1, Ordering::SeqCst);
                        let mut sock = sock;
                        serve(&mut sock, &cfg, n, &r2);
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(5)),
                }
            }
        });
        Server {
            url: format!("http://{addr}/asset"),
            base: format!("http://{addr}"),
            hits,
            range_hits,
            stop,
        }
    }

    fn serve(sock: &mut TcpStream, cfg: &ServerCfg, hit: usize, range_hits: &AtomicUsize) {
        let mut reader = BufReader::new(sock.try_clone().expect("clone"));
        let mut range: Option<u64> = None;
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            let l = line.trim().to_lowercase();
            if let Some(rest) = l.strip_prefix("range: bytes=") {
                if let Some(dash) = rest.find('-') {
                    range = rest[..dash].parse::<u64>().ok();
                }
                range_hits.fetch_add(1, Ordering::SeqCst);
            }
            if line == "\r\n" {
                break;
            }
            line.clear();
        }
        if hit < cfg.fail_first {
            let _ = sock.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return;
        }
        let total = cfg.body.len() as u64;
        let start = match range {
            Some(s) if cfg.support_range => s,
            _ => 0,
        };
        let sent_partial = start > 0;
        if start >= total {
            let _ = sock.write_all(
                format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            );
            return;
        }
        let slice = &cfg.body[start as usize..];
        let head = if sent_partial {
            format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
                slice.len(),
                start,
                total - 1,
                total
            )
        } else {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                slice.len()
            )
        };
        let _ = sock.write_all(head.as_bytes());
        for chunk in slice.chunks(8192) {
            if sock.write_all(chunk).is_err() {
                return;
            }
            if cfg.chunk_delay_ms > 0 {
                std::thread::sleep(Duration::from_millis(cfg.chunk_delay_ms));
            }
        }
    }

    fn body_of(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i % 251) as u8).collect()
    }

    /// 代理相关测试共用的 env 锁：env 是进程级全局态，测试并行会互相污染
    /// （踩过：某测试写入 no_proxy=127.0.0.1 后，另一个测试的**显式**代理被一起豁免）。
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 在「无代理 env」环境下运行闭包（保存/清空/恢复），保证断言只反映代码行为
    fn without_proxy_env<T>(f: impl FnOnce() -> T) -> T {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let keys = [
            "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
            "NO_PROXY", "no_proxy",
        ];
        let saved: Vec<(&str, Option<String>)> =
            keys.iter().map(|k| (*k, std::env::var(k).ok())).collect();
        for k in keys {
            std::env::remove_var(k);
        }
        let out = f();
        for (k, v) in saved {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
        out
    }

    fn client() -> reqwest::blocking::Client {
        // 与生产同款「回环客户端」：彻底禁用代理。
        // 否则环境里的 HTTP_PROXY（本机实测存在）会把本地假服务器的请求劫走 → 断言全乱。
        crate::model_manager::loopback_client_builder(Duration::from_secs(30))
            .build()
            .expect("client")
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("voxflow_net_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("mkdir");
        d
    }

    #[test]
    fn fresh_download_is_atomic_and_reports_progress() {
        let body = body_of(200 * 1024);
        let srv = spawn(ServerCfg {
            body: body.clone(),
            support_range: true,
            fail_first: 0,
            chunk_delay_ms: 0,
        });
        let dir = tmpdir("fresh");
        let dest = dir.join("asset.bin");
        let seen: Mutex<Vec<(u64, Option<u64>)>> = Mutex::new(Vec::new());
        let cb = |d: u64, t: Option<u64>| seen.lock().push((d, t));
        let n = download(
            &client(),
            &Download {
                url: &srv.url,
                dest: &dest,
                on_progress: Some(&cb),
                cancel: None,
                headers: &[],
            },
        )
        .expect("download");
        assert_eq!(n, body.len() as u64);
        assert_eq!(std::fs::read(&dest).expect("read"), body, "内容必须与源一致");
        assert!(!part_path(&dest).exists(), "完成后 .part 必须被 rename 掉");
        let seen = seen.lock();
        assert_eq!(seen.last().unwrap(), &(body.len() as u64, Some(body.len() as u64)), "结束时补终值");
        assert!(seen.windows(2).all(|w| w[0].0 <= w[1].0), "进度单调不减");
    }

    #[test]
    fn resume_from_existing_part_uses_range() {
        let body = body_of(200 * 1024);
        let srv = spawn(ServerCfg {
            body: body.clone(),
            support_range: true,
            fail_first: 0,
            chunk_delay_ms: 0,
        });
        let dir = tmpdir("resume");
        let dest = dir.join("asset.bin");
        std::fs::write(part_path(&dest), &body[..50 * 1024]).expect("seed part");
        let n = download(
            &client(),
            &Download { url: &srv.url, dest: &dest, on_progress: None, cancel: None, headers: &[] },
        )
        .expect("download");
        assert_eq!(n, body.len() as u64);
        assert_eq!(std::fs::read(&dest).expect("read"), body, "续传后内容必须完整且不重复");
        assert_eq!(srv.range_hits.load(Ordering::SeqCst), 1, "必须发起 Range 请求");
    }

    #[test]
    fn server_without_range_support_restarts_cleanly() {
        let body = body_of(150 * 1024);
        let srv = spawn(ServerCfg {
            body: body.clone(),
            support_range: false,
            fail_first: 0,
            chunk_delay_ms: 0,
        });
        let dir = tmpdir("norange");
        let dest = dir.join("asset.bin");
        std::fs::write(part_path(&dest), &body[..50 * 1024]).expect("seed part");
        download(
            &client(),
            &Download { url: &srv.url, dest: &dest, on_progress: None, cancel: None, headers: &[] },
        )
        .expect("download");
        // 服务器忽略 Range（返 200 全量）：必须截断重下，绝不能把全量追加到旧分片后
        assert_eq!(std::fs::read(&dest).expect("read"), body);
    }

    #[test]
    fn stale_part_triggers_416_then_restart() {
        let body = body_of(100 * 1024);
        let srv = spawn(ServerCfg {
            body: body.clone(),
            support_range: true,
            fail_first: 0,
            chunk_delay_ms: 0,
        });
        let dir = tmpdir("stale");
        let dest = dir.join("asset.bin");
        // 分片比目标还长 → 服务器 416 → 丢弃后重下
        std::fs::write(part_path(&dest), vec![0u8; body.len() + 4096]).expect("seed part");
        download(
            &client(),
            &Download { url: &srv.url, dest: &dest, on_progress: None, cancel: None, headers: &[] },
        )
        .expect("download");
        assert_eq!(std::fs::read(&dest).expect("read"), body);
    }

    #[test]
    fn cancel_aborts_without_dest_and_leaves_resumable_state() {
        let body = body_of(256 * 1024);
        let srv = spawn(ServerCfg {
            body: body.clone(),
            support_range: true,
            fail_first: 0,
            chunk_delay_ms: 8, // 慢发，保证取消发生在下载中途
        });
        let dir = tmpdir("cancel");
        let dest = dir.join("asset.bin");
        let cancel = Arc::new(AtomicBool::new(false));
        let c2 = cancel.clone();
        let seen = AtomicUsize::new(0);
        let cb = |_d: u64, _t: Option<u64>| {
            if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                // 首个回调即取消：下一次读块检查点生效
                c2.store(true, Ordering::SeqCst);
            }
        };
        let err = download(
            &client(),
            &Download {
                url: &srv.url,
                dest: &dest,
                on_progress: Some(&cb),
                cancel: Some(&cancel),
                headers: &[],
            },
        )
        .expect_err("应被取消");
        assert_eq!(err, CANCELLED);
        assert!(!dest.exists(), "取消不得产生 dest（未 rename）");
        let part = part_path(&dest);
        assert!(part.exists(), "取消后必须保留 .part（下次可续/可重下）");
        assert!(std::fs::metadata(&part).unwrap().len() <= body.len() as u64, "分片不得超过目标长度");

        // 取消后重跑（不取消）必须能完整完成：证明取消留下的状态可恢复
        let n = download(
            &client(),
            &Download {
                url: &srv.url,
                dest: &dest,
                on_progress: None,
                cancel: Some(&AtomicBool::new(false)),
                headers: &[],
            },
        )
        .expect("取消后重跑应成功");
        assert_eq!(n, body.len() as u64);
        assert_eq!(std::fs::read(&dest).expect("read"), body);
    }

    /// 代理必须真的生效：请求打到代理，而不是直连目标。
    /// （reqwest 是 `default-features = false`（无 system-proxy）→ 只写 HTTP(S)_PROXY 环境变量无效，
    /// 必须 `builder.proxy(Proxy::all(..))`；这条测试锁住该行为，防回归）
    #[test]
    fn proxy_is_actually_used() {
        without_proxy_env(|| {
        let body = body_of(32 * 1024);
        let target = spawn(ServerCfg {
            body: body.clone(),
            support_range: true,
            fail_first: 0,
            chunk_delay_ms: 0,
        });
        let proxy = spawn(ServerCfg {
            body: body.clone(),
            support_range: true,
            fail_first: 0,
            chunk_delay_ms: 0,
        });
        let dir = tmpdir("proxy");
        let dest = dir.join("asset.bin");
        let client = reqwest::blocking::Client::builder()
            .proxy(reqwest::Proxy::all(&proxy.base).expect("proxy url"))
            .timeout(Duration::from_secs(30))
            .build()
            .expect("client");
        download(
            &client,
            &Download {
                url: &target.url,
                dest: &dest,
                on_progress: None,
                cancel: None,
                headers: &[],
            },
        )
        .expect("通过代理下载");
        assert_eq!(std::fs::read(&dest).expect("read"), body);
        assert_eq!(proxy.hits.load(Ordering::SeqCst), 1, "请求必须经过代理");
        assert_eq!(target.hits.load(Ordering::SeqCst), 0, "配了代理就不应直连目标");
        });
    }

    /// 回环不变式：env 里配了代理时，回环客户端（生产 llama-server 用同款）必须仍直连。
    /// 否则用户环境里的 HTTP_PROXY 一旦不可用，整个 ASR 的健康检查/转写都会挂。
    #[test]
    fn loopback_never_uses_proxy() {
        without_proxy_env(|| {
            let body = body_of(8 * 1024);
            let target = spawn(ServerCfg { body: body.clone(), support_range: true, fail_first: 0, chunk_delay_ms: 0 });
            let proxy = spawn(ServerCfg { body: body.clone(), support_range: true, fail_first: 0, chunk_delay_ms: 0 });
            std::env::set_var("HTTP_PROXY", &proxy.base);
            std::env::set_var("http_proxy", &proxy.base);
            let client = crate::model_manager::loopback_client_builder(Duration::from_secs(30))
                .build()
                .expect("client");
            let dir = tmpdir("loopback");
            let dest = dir.join("a.bin");
            download(
                &client,
                &Download { url: &target.url, dest: &dest, on_progress: None, cancel: None, headers: &[] },
            )
            .expect("download");
            assert_eq!(target.hits.load(Ordering::SeqCst), 1, "回环应直连目标");
            assert_eq!(
                proxy.hits.load(Ordering::SeqCst),
                0,
                "回环绝不应走代理（env 代理存在时也一样）"
            );
        });
    }

    #[test]
    fn skips_when_dest_already_complete() {
        let srv = spawn(ServerCfg {
            body: body_of(4096),
            support_range: true,
            fail_first: 0,
            chunk_delay_ms: 0,
        });
        let dir = tmpdir("skip");
        let dest = dir.join("asset.bin");
        std::fs::write(&dest, b"already here").expect("seed dest");
        let n = download(
            &client(),
            &Download { url: &srv.url, dest: &dest, on_progress: None, cancel: None, headers: &[] },
        )
        .expect("skip");
        assert_eq!(n, 12);
        assert_eq!(std::fs::read(&dest).expect("read"), b"already here");
        assert_eq!(srv.hits.load(Ordering::SeqCst), 0, "已存在则不应发请求");
    }

    #[test]
    fn retries_transient_5xx_then_succeeds() {
        let body = body_of(64 * 1024);
        let srv = spawn(ServerCfg {
            body: body.clone(),
            support_range: true,
            fail_first: 1,
            chunk_delay_ms: 0,
        });
        let dir = tmpdir("retry");
        let dest = dir.join("asset.bin");
        download(
            &client(),
            &Download { url: &srv.url, dest: &dest, on_progress: None, cancel: None, headers: &[] },
        )
        .expect("retry then ok");
        assert_eq!(std::fs::read(&dest).expect("read"), body);
        // 契约是「5xx 会被重试且最终成功」，不是「恰好两个请求」：
        // 并行跑整套测试时负载高，传输层错误可能额外触发一次重试（实测偶发 hits=3）。
        let hits = srv.hits.load(Ordering::SeqCst);
        assert!(hits >= 2, "首个 5xx 之后必须重试（实际 {hits} 次请求）");
    }
}
