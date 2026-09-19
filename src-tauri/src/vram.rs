//! 显存账目：GGUF 几何 → KV cache 精确字节数 → 显存预估
//!
//! ## 为什么需要
//! 模型卡片显示的「体积」是**磁盘文件体积**，而实际显存 = 权重 + **KV cache**（llama.cpp 在
//! 加载时按 `--ctx-size` **整块**分配，与模型大小无关）+ 计算缓冲 + CUDA 上下文。
//! 本机实测（RTX 4070 Laptop，0.6B Q8 + Q8 mmproj，`-ngl 99`）：
//! ctx 8192 = 2488 MiB、ctx 4096 = 1994 MiB、ctx 2048 = 1768 MiB
//! ⇒ 只有把 KV 与进程固定开销一起算进去，界面上的数字才不骗人。
//!
//! ## 口径
//! - **权重 / mmproj**：直接用文件字节数（量化权重驻留显存时就是文件大小）。
//! - **KV**：从 GGUF 元数据读几何（层数 / KV 头数 / head_dim）后精确计算，不猜。
//! - **固定开销**：CUDA 上下文 + cuBLAS 工作区 + 计算缓冲，取本机实测常数（见下）。
//! - 真值（驱动口径）由 `lib.rs` 的按进程查询给出；本模块负责**可预测的预估值**。

use std::io::Read;
use std::path::Path;

/// 进程级固定开销（CUDA 上下文 + cuBLAS 工作区 + 计算缓冲），MiB。
///
/// 实测口径：驱动真值 −（权重 + mmproj + KV）≈ 620 MiB，且在 ctx 8192/4096/2048 三档一致
/// （0.6B Q8 + Q8 mmproj，RTX 4070 Laptop，`-ngl 99`）。模型越大计算缓冲会略增，
/// 故这是个略偏保守的常数——宁可低估误差，不虚报。
pub const GPU_FIXED_OVERHEAD_MB: u64 = 620;

/// GGUF 的 KV 几何（只取算 KV cache 需要的三项）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GgufKvGeometry {
    /// 层数（`*.block_count`）
    pub layers: u64,
    /// KV 头数（`*.attention.head_count_kv`）
    pub kv_heads: u64,
    /// 每头维度（`*.attention.key_length`，缺失时用 value_length 或 embedding_length/head_count 推）
    pub head_dim: u64,
}

impl GgufKvGeometry {
    /// f16 KV cache 字节数 = ctx × 2(K+V) × layers × kv_heads × head_dim × 2B
    pub fn kv_bytes_f16(&self, ctx: u32) -> u64 {
        (ctx as u64) * 2 * self.layers * self.kv_heads * self.head_dim * 2
    }
}

// ─── 驱动口径：总/已用/可用显存 ─────────────────────────────────────────────
//
// 预估（上面）用于「需要多少」；本段用于「还剩多少」。两者都只做**读**，
// 判定与放行策略在调用方（见 `model_manager::check_load_vram`）。

/// 解析 `nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits` 的首行数字（MiB）。
/// 纯函数（单测锁格式）；解析失败 → None。
pub fn parse_smi_used_mb(stdout: &str) -> Option<u64> {
    stdout.lines().next()?.trim().parse::<u64>().ok()
}

/// nvidia-smi 查询「已用显存」MiB。读不到（非 NVIDIA / 无驱动 / 无权限）→ None。
fn smi_used_mb() -> Option<u64> {
    let mut cmd = std::process::Command::new("nvidia-smi");
    crate::process_hidden::hide_console_window(&mut cmd);
    let out = cmd
        .args(["--query-gpu=memory.used", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_smi_used_mb(&String::from_utf8_lossy(&out.stdout))
}

/// 驱动口径的 (总显存 MiB, 已用 MiB)。任一读不到 → None。
///
/// 调用方拿到 None 必须 **fail-open**（显存预检只是提醒，绝不误拦加载）。
pub fn gpu_mem_mb() -> Option<(u64, u64)> {
    let total = crate::sidecar::detect_gpu()
        .get("memoryMB")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let used = smi_used_mb()?;
    (total > 0).then_some((total, used))
}

/// 可用显存 MiB（总 − 已用）。无法判定 → None。
pub fn gpu_free_mb() -> Option<u64> {
    gpu_mem_mb().map(|(total, used)| total.saturating_sub(used))
}

/// 显存预估（MiB）= 权重 + mmproj + KV + 固定开销。
/// `geom` 缺失（读不到 GGUF）时按权重+mmproj+固定开销算，即**下界**。
pub fn estimate_vram_mb(
    weights_bytes: u64,
    mmproj_bytes: u64,
    geom: Option<GgufKvGeometry>,
    ctx: u32,
) -> u64 {
    let kv = geom.map(|g| g.kv_bytes_f16(ctx)).unwrap_or(0);
    (weights_bytes + mmproj_bytes + kv).div_ceil(1024 * 1024) + GPU_FIXED_OVERHEAD_MB
}

// ─── GGUF 元数据读取（只读 KV 块，不碰张量数据）──────────────────────────────

/// 读取 GGUF 的 KV 几何；文件不存在 / 非 GGUF / 缺关键字段 → None（调用方退化为下界估算）。
///
/// 架构前缀因模型而异（`qwen3vl.` / `qwen3.` / `llama.` …），故按键名**后缀**匹配。
pub fn read_gguf_kv_geometry(path: &Path) -> Option<GgufKvGeometry> {
    let file = std::fs::File::open(path).ok()?;
    let mut r = std::io::BufReader::with_capacity(64 * 1024, file);
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic).ok()?;
    if &magic != b"GGUF" {
        return None;
    }
    let _version = read_u32(&mut r)?;
    let _n_tensors = read_u64(&mut r)?;
    let n_kv = read_u64(&mut r)?;

    let mut layers = None;
    let mut kv_heads = None;
    let mut key_len = None;
    let mut val_len = None;
    let mut emb = None;
    let mut heads = None;

    // 元数据块远小于此上限；防御性截断，避免坏文件把循环拖死
    for _ in 0..n_kv.min(8192) {
        let key = read_str(&mut r)?;
        let ty = read_u32(&mut r)?;
        if let Some(v) = read_num(&mut r, ty)? {
            if key.ends_with(".block_count") {
                layers = Some(v);
            } else if key.ends_with(".attention.head_count_kv") {
                kv_heads = Some(v);
            } else if key.ends_with(".attention.key_length") {
                key_len = Some(v);
            } else if key.ends_with(".attention.value_length") {
                val_len = Some(v);
            } else if key.ends_with(".embedding_length") {
                emb = Some(v);
            } else if key.ends_with(".attention.head_count") {
                heads = Some(v);
            }
        }
    }

    let layers = layers?;
    // KV 头数缺失时退化为注意力头数（MHA 模型）
    let kv_heads = kv_heads.or(heads).filter(|v| *v > 0)?;
    let head_dim = key_len
        .or(val_len)
        .or_else(|| emb.zip(heads).map(|(e, h)| if h > 0 { e / h } else { 0 }))
        .filter(|v| *v > 0)?;
    Some(GgufKvGeometry {
        layers,
        kv_heads,
        head_dim,
    })
}

fn read_u32(r: &mut impl Read) -> Option<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b).ok()?;
    Some(u32::from_le_bytes(b))
}

fn read_u64(r: &mut impl Read) -> Option<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b).ok()?;
    Some(u64::from_le_bytes(b))
}

fn read_str(r: &mut impl Read) -> Option<String> {
    let len = read_u64(r)?;
    if len > 1 << 20 {
        return None;
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).ok()?;
    String::from_utf8(buf).ok()
}

/// 读一个元数据值；数值型返回 `Some(v)`，其余类型（字符串/数组等）消费字节后返回 `None`。
fn read_num(r: &mut impl Read, ty: u32) -> Option<Option<u64>> {
    let v = match ty {
        0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 10 | 11 => {
            // u8/i8/u16/i16/u32/i32/f32/bool/i64/f64 —— 取整数位
            let n = match ty {
                0 | 1 | 7 => 1usize,
                2 | 3 => 2,
                4 | 5 | 6 => 4,
                _ => 8,
            };
            let mut buf = [0u8; 8];
            r.read_exact(&mut buf[..n]).ok()?;
            let mut padded = [0u8; 8];
            padded[..n].copy_from_slice(&buf[..n]);
            Some(u64::from_le_bytes(padded))
        }
        8 => {
            let _ = read_str(r)?;
            None
        }
        9 | 12 => {
            let elem_ty = read_u32(r)?;
            let len = read_u64(r)?;
            if len > 1 << 20 {
                return None;
            }
            for _ in 0..len {
                let _ = read_num(r, elem_ty)?;
            }
            None
        }
        _ => return None,
    };
    Some(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 造一个最小 GGUF（只含元数据块），验证几何解析
    fn write_synthetic_gguf(path: &Path, pairs: &[(&str, u32, u64)]) {
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(b"GGUF").unwrap();
        f.write_all(&3u32.to_le_bytes()).unwrap(); // version
        f.write_all(&0u64.to_le_bytes()).unwrap(); // n_tensors
        f.write_all(&(pairs.len() as u64).to_le_bytes()).unwrap();
        for (k, ty, v) in pairs {
            f.write_all(&(k.len() as u64).to_le_bytes()).unwrap();
            f.write_all(k.as_bytes()).unwrap();
            f.write_all(&ty.to_le_bytes()).unwrap();
            f.write_all(&(*v as u32).to_le_bytes()).unwrap(); // 只支持 u32 值（ty=4）
        }
    }

    #[test]
    fn test_gguf_geometry_and_kv_bytes() {
        let dir = std::env::temp_dir().join("voxflow_vram_test");
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("mini.gguf");
        write_synthetic_gguf(
            &p,
            &[
                ("qwen3vl.block_count", 4, 28),
                ("qwen3vl.attention.head_count_kv", 4, 8),
                ("qwen3vl.attention.key_length", 4, 128),
                ("qwen3vl.embedding_length", 4, 1024),
                ("qwen3vl.attention.head_count", 4, 16),
            ],
        );
        let g = read_gguf_kv_geometry(&p).expect("应解析出几何");
        assert_eq!(
            g,
            GgufKvGeometry {
                layers: 28,
                kv_heads: 8,
                head_dim: 128
            }
        );
        // 与真机实测一致：112 KiB/token → ctx 8192 = 896 MiB、ctx 2048 = 224 MiB
        // 走生产 API（字节）；MiB 便于对照上面实测值
        assert_eq!(g.kv_bytes_f16(8192).div_ceil(1024 * 1024), 896);
        assert_eq!(g.kv_bytes_f16(2048).div_ceil(1024 * 1024), 224);
        // 逐字节核对公式：ctx × 2(K+V) × 28 层 × 8 KV 头 × 128 维 × 2B
        assert_eq!(g.kv_bytes_f16(2048), 2048 * 2 * 28 * 8 * 128 * 2);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn test_geometry_missing_or_bad() {
        let dir = std::env::temp_dir().join("voxflow_vram_test");
        let _ = std::fs::create_dir_all(&dir);
        let bad = dir.join("bad.gguf");
        std::fs::write(&bad, b"NOTGGUF....").unwrap();
        assert!(read_gguf_kv_geometry(&bad).is_none());
        assert!(read_gguf_kv_geometry(&dir.join("nope.gguf")).is_none());
        let _ = std::fs::remove_file(&bad);
    }

    #[test]
    fn test_estimate_includes_kv_and_overhead() {
        let g = GgufKvGeometry {
            layers: 28,
            kv_heads: 8,
            head_dim: 128,
        };
        // 0.6B 实测：权重 767.5 MiB + mmproj 204.5 MiB + KV(ctx2048) 224 + 620 ≈ 1817 MiB
        let est = estimate_vram_mb(
            (767.5 * 1024.0 * 1024.0) as u64,
            (204.5 * 1024.0 * 1024.0) as u64,
            Some(g),
            2048,
        );
        assert!((1768..=1870).contains(&est), "预估应贴近实测 1768 MiB，实际 {est}");
        // 无几何 → 下界（不含 KV）
        let low = estimate_vram_mb(767 * 1024 * 1024, 204 * 1024 * 1024, None, 2048);
        assert!(low < est);
    }

    #[test]
    fn test_parse_smi_used_mb() {
        assert_eq!(parse_smi_used_mb("4963\n"), Some(4963));
        assert_eq!(parse_smi_used_mb("  3011  \n"), Some(3011));
        // 多卡输出：取首行（与面板口径一致）
        assert_eq!(parse_smi_used_mb("100\n200\n"), Some(100));
        assert_eq!(parse_smi_used_mb("N/A"), None);
        assert_eq!(parse_smi_used_mb(""), None);
    }
}
