// ═══════════════════════════════════════════════════════════════
//  أوامر Tauri (Tauri Commands) — المرحلة 2
//  1. كشف السكتات (Silence Detection) عبر FFmpeg
//  2. التفريغ الصوتي (Transcription) عبر Groq/OpenAI Whisper API
// ═══════════════════════════════════════════════════════════════

use crate::{
    check_ffmpeg, file_size_mb, generate_output_name, get_file_stem, get_projects_dir,
    get_temp_dir, is_supported_media, is_supported_video,
};
use crate::{
    AppError, AudioExtractionResult, ExportResult, ProjectMeta, ShortExtractResult,
    ShortSuggestion, SilenceDetectionResult, SilenceSegment, TimeRange, TranscriptionResult,
    TranscriptIssue, VideoInfo, WordTimestamp,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

// ═══════════════════════════════════════════════════════════════
//  أوامر المرحلة 1 (موجودة مسبقاً)
// ═══════════════════════════════════════════════════════════════

/// فتح نافذة اختيار ملف فيديو من الجهاز
#[tauri::command]
pub async fn pick_video_file(
    app: tauri::AppHandle,
) -> Result<Option<VideoInfo>, AppError> {
    log::info!("فتح نافذة اختيار ملف فيديو...");

    let file_path = app
        .dialog()
        .file()
        .add_filter(
            "ملفات الفيديو",
            &[
                "mp4",
                "avi",
                "mkv",
                "mov",
                "wmv",
                "flv",
                "webm",
                "m4v",
                "mpg",
                "mpeg",
                "ts",
                "3gp",
            ],
        )
        .blocking_pick_file();

    match file_path {
        Some(path) => {
            let path_str = path.to_string();

            if !is_supported_video(&path_str) {
                return Err(AppError {
                    error_type: "UnsupportedFormat".into(),
                    message: "صيغة الملف غير مدعومة".into(),
                    details: Some(format!(
                        "الملف: {}\nالصيغ المدعومة: mp4, avi, mkv, mov, wmv, flv, webm, m4v",
                        path_str
                    )),
                });
            }

            if !Path::new(&path_str).exists() {
                return Err(AppError {
                    error_type: "FileNotFound".into(),
                    message: "الملف غير موجود أو تعذّر الوصول إليه".into(),
                    details: Some(path_str.clone()),
                });
            }

            let file_name = get_file_stem(&path_str);
            let file_size = file_size_mb(&path_str)?;

            log::info!("تم اختيار: {} ({:.2} MB)", file_name, file_size);

            Ok(Some(VideoInfo {
                path: path_str,
                file_name,
                file_size_mb: file_size,
            }))
        }
        None => {
            log::info!("ألغى المستخدم اختيار الملف");
            Ok(None)
        }
    }
}

/// 📁 فتح حوار اختيار مجلد المخرجات (plan.md §0.5)
#[tauri::command]
pub async fn pick_output_folder(
    app: tauri::AppHandle,
) -> Result<Option<String>, AppError> {
    let folder = app.dialog().file().blocking_pick_folder();
    match folder {
        Some(path) => {
            let path_str = path.to_string();
            // نقبل فقط المسارات التي هي مجلدات قائمة فعلاً
            if Path::new(&path_str).is_dir() {
                log::info!("📁 اختار المستخدم مجلد المخرجات: {}", path_str);
                Ok(Some(path_str))
            } else {
                Ok(None)
            }
        }
        None => Ok(None),
    }
}

/// 📂 فتح نافذة اختيار ملف صوت أو فيديو (مسار النصّ — plan.md §3.1)
#[tauri::command]
pub async fn pick_media_file(app: tauri::AppHandle) -> Result<Option<VideoInfo>, AppError> {
    log::info!("فتح نافذة اختيار ملف صوت/فيديو...");

    let file_path = app
        .dialog()
        .file()
        .add_filter(
            "ملفات الصوت والفيديو",
            &[
                "mp4", "avi", "mkv", "mov", "wmv", "flv", "webm", "m4v",
                "mpg", "mpeg", "ts", "3gp",
                "mp3", "wav", "m4a", "aac", "ogg", "flac", "wma", "opus", "oga",
            ],
        )
        .blocking_pick_file();

    match file_path {
        Some(path) => {
            let path_str = path.to_string();

            if !is_supported_media(&path_str) {
                return Err(AppError {
                    error_type: "UnsupportedFormat".into(),
                    message: "صيغة الملف غير مدعومة".into(),
                    details: Some(format!(
                        "الملف: {}\nالصيغ المدعومة: صوت (mp3, wav, m4a, aac…) وفيديو (mp4, mkv, mov…)",
                        path_str
                    )),
                });
            }

            if !Path::new(&path_str).exists() {
                return Err(AppError {
                    error_type: "FileNotFound".into(),
                    message: "الملف غير موجود أو تعذّر الوصول إليه".into(),
                    details: Some(path_str.clone()),
                });
            }

            let file_name = get_file_stem(&path_str);
            let file_size = file_size_mb(&path_str)?;
            log::info!("تم اختيار: {} ({:.2} MB)", file_name, file_size);

            Ok(Some(VideoInfo {
                path: path_str,
                file_name,
                file_size_mb: file_size,
            }))
        }
        None => {
            log::info!("ألغى المستخدم اختيار الملف");
            Ok(None)
        }
    }
}

/// استخراج الصوت من الفيديو وتحويله إلى MP3
#[tauri::command]
pub async fn extract_audio(
    app: tauri::AppHandle,
    video_path: String,
) -> Result<AudioExtractionResult, AppError> {
    log::info!("بدء استخراج الصوت من: {}", video_path);

    let ffmpeg = check_ffmpeg()?;

    if !Path::new(&video_path).exists() {
        return Err(AppError {
            error_type: "FileNotFound".into(),
            message: "ملف الفيديو غير موجود".into(),
            details: Some(video_path),
        });
    }

    let temp_dir = get_temp_dir(&app)?;
    let output_name = generate_output_name(&video_path);
    let output_path = temp_dir.join(&output_name);
    let output_str = output_path.to_string_lossy().to_string();

    log::info!("المسار المؤقت للإخراج: {}", output_str);

    let ffmpeg_output = Command::new(&ffmpeg)
        .args([
            "-i", &video_path,
            "-vn",
            "-acodec", "libmp3lame",
            "-ab", "128k",
            "-ar", "44100",
            "-map", "a",
            "-y",
            &output_str,
        ])
        .output()
        .map_err(|e| AppError {
            error_type: "FFmpegExecutionError".into(),
            message: format!("فشل تشغيل FFmpeg: {}", e),
            details: None,
        })?;

    if !ffmpeg_output.status.success() {
        let stderr = String::from_utf8_lossy(&ffmpeg_output.stderr);
        let stdout = String::from_utf8_lossy(&ffmpeg_output.stdout);

        log::error!("FFmpeg stderr: {}", stderr);

        let error_msg = if stderr.contains("Stream map 'a' matches no streams") {
            "الفيديو لا يحتوي على مسار صوتي".to_string()
        } else if stderr.contains("No such file or directory") {
            "ملف الفيديو غير موجود".to_string()
        } else if stderr.contains("Invalid data") {
            "الملف تالف أو بصيغة غير مدعومة".to_string()
        } else {
            format!(
                "خطأ في المعالجة. كود الخروج: {:?}",
                ffmpeg_output.status.code()
            )
        };

        return Err(AppError {
            error_type: "FFmpegProcessingError".into(),
            message: error_msg,
            details: Some(format!("FFmpeg Output:\n{}\n{}", stdout, stderr)),
        });
    }

    let output_size = file_size_mb(&output_str)?;

    log::info!("✅ تم استخراج الصوت: {} ({:.2} MB)", output_str, output_size);

    Ok(AudioExtractionResult {
        success: true,
        output_path: output_str,
        message: format!("تم استخراج الصوت بنجاح ({:.2} MB)", output_size),
        output_size_mb: output_size,
    })
}

/// فحص سريع لتوفّر FFmpeg
#[tauri::command]
pub async fn ffmpeg_status() -> Result<bool, AppError> {
    match check_ffmpeg() {
        Ok(path) => {
            log::info!("FFmpeg متوفّر في: {}", path);
            Ok(true)
        }
        Err(e) => {
            log::warn!("FFmpeg غير متوفّر: {}", e);
            Ok(false)
        }
    }
}

// ═══════════════════════════════════════════════════════════════
//  المرحلة 2 — كشف السكتات (Silence Detection)
// ═══════════════════════════════════════════════════════════════

/// 🔇 كشف السكتات والصمت في ملف صوتي/فيديو
///
/// يستخدم فلتر FFmpeg `silencedetect` لتحديد الفترات الزمنية
/// التي يقل فيها الصوت عن `noise_threshold` (بالديسيبل)
/// وتستمر لأكثر من `min_duration` (بالثواني).
///
/// # المعاملات
/// - `audio_path`: مسار ملف الصوت أو الفيديو
/// - `noise_threshold`: حد الضوضاء بالديسيبل (افتراضي: -30dB)
/// - `min_duration`: الحد الأدنى لمدة الصمت بالثواني (افتراضي: 0.5)
#[tauri::command]
pub async fn detect_silence(
    audio_path: String,
    noise_threshold: Option<f64>,
    min_duration: Option<f64>,
) -> Result<SilenceDetectionResult, AppError> {
    let noise_db = noise_threshold.unwrap_or(-30.0);
    let min_dur = min_duration.unwrap_or(0.5);

    log::info!(
        "🔍 كشف السكتات: {} (حد الضوضاء: {}dB، الحد الأدنى: {}ث)",
        audio_path,
        noise_db,
        min_dur
    );

    let ffmpeg = check_ffmpeg()?;

    if !Path::new(&audio_path).exists() {
        return Err(AppError {
            error_type: "FileNotFound".into(),
            message: "ملف الصوت غير موجود".into(),
            details: Some(audio_path),
        });
    }

    // كشف فترات الصمت (يُعاد استخدامه أيضاً في تقسيم الملفات الطويلة)
    let segments = run_silence_detect(&ffmpeg, &audio_path, noise_db, min_dur)?;

    // مدة الملف الكلية من ترويسة FFmpeg
    let total_duration = probe_duration(&ffmpeg, &audio_path)?;

    let total_silence: f64 = segments.iter().map(|s| s.duration).sum();
    let silence_ratio = if total_duration > 0.0 {
        total_silence / total_duration
    } else {
        0.0
    };

    log::info!(
        "✅ تم العثور على {} سكتة (إجمالي الصمت: {:.1}s من {:.1}s = {:.0}%)",
        segments.len(),
        total_silence,
        total_duration,
        silence_ratio * 100.0
    );

    Ok(SilenceDetectionResult {
        segments,
        total_silence_duration: total_silence,
        total_audio_duration: total_duration,
        silence_count: 0, // يُحسب في الواجهة
        silence_ratio,
    })
}

/// تحليل مخرجات FFmpeg silencedetect لاستخراج فترات الصمت
///
/// يبحث عن أسطر مثل:
///   [silencedetect @ ...] silence_start: 12.3456
///   [silencedetect @ ...] silence_end: 13.5678 | silence_duration: 1.2222
fn parse_silence_output(output: &str) -> Result<Vec<SilenceSegment>, AppError> {
    let mut starts: Vec<f64> = Vec::new();
    let mut ends: Vec<f64> = Vec::new();
    let mut durations: Vec<f64> = Vec::new();

    // أنماط regex لاستخراج القيم
    let start_re =
        Regex::new(r"silence_start:\s*([\d.]+)").map_err(|e| AppError {
            error_type: "RegexError".into(),
            message: format!("خطأ في نمط Regex: {}", e),
            details: None,
        })?;

    let end_re =
        Regex::new(r"silence_end:\s*([\d.]+).*silence_duration:\s*([\d.]+)")
            .map_err(|e| AppError {
                error_type: "RegexError".into(),
                message: format!("خطأ في نمط Regex: {}", e),
                details: None,
            })?;

    // نمرّ على كل سطر
    for line in output.lines() {
        if let Some(caps) = start_re.captures(line) {
            if let Ok(val) = caps[1].parse::<f64>() {
                starts.push(val);
            }
        }

        if let Some(caps) = end_re.captures(line) {
            if let (Ok(end_val), Ok(dur_val)) =
                (caps[1].parse::<f64>(), caps[2].parse::<f64>())
            {
                ends.push(end_val);
                durations.push(dur_val);
            }
        }
    }

    // دمج البدايات والنهايات في فترات (segments)
    let mut segments = Vec::new();

    // في الحالة المثالية: عدد البدايات = عدد النهايات
    // لكن قد تنتهي السكتة الأخيرة مع نهاية الملف دون silence_end
    let pair_count = starts.len().min(ends.len());

    for i in 0..pair_count {
        segments.push(SilenceSegment {
            start: starts[i],
            end: ends[i],
            duration: durations[i],
        });
    }

    // إذا كان هناك بداية بلا نهاية (سكتة حتى نهاية الملف)
    if starts.len() > ends.len() {
        let last_start = starts[starts.len() - 1];
        log::warn!(
            "سكتة تبدأ عند {:.2}s دون نهاية واضحة (قد تمتد حتى نهاية الملف)",
            last_start
        );
        // نضع تقديراً للنهاية (المستوى الصوتي قد ينتهي هنا)
    }

    // ترتيب الفترات زمنياً (احتياطي)
    segments.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));

    Ok(segments)
}

/// استخراج مدة الملف الصوتي من مخرجات FFmpeg
/// يبحث عن: Duration: 00:03:45.12
fn extract_audio_duration(stderr: &str) -> f64 {
    let duration_re = Regex::new(r"Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)")
        .unwrap_or_else(|_| Regex::new(r"").unwrap());

    if let Some(caps) = duration_re.captures(stderr) {
        let hours: f64 = caps[1].parse().unwrap_or(0.0);
        let minutes: f64 = caps[2].parse().unwrap_or(0.0);
        let seconds: f64 = caps[3].parse().unwrap_or(0.0);
        return hours * 3600.0 + minutes * 60.0 + seconds;
    }

    0.0
}

/// تشغيل فلتر silencedetect وتحليل النتيجة إلى فترات صمت مرتّبة زمنياً.
/// أداة مشتركة: كشف السكتات + تخطيط تقسيم الملفات الطويلة (plan.md §0.2).
fn run_silence_detect(
    ffmpeg: &str,
    audio_path: &str,
    noise_db: f64,
    min_dur: f64,
) -> Result<Vec<SilenceSegment>, AppError> {
    let filter = format!("silencedetect=noise={}dB:d={}", noise_db, min_dur);
    let ffmpeg_output = Command::new(ffmpeg)
        .args(["-i", audio_path, "-af", &filter, "-f", "null", "-"])
        .output()
        .map_err(|e| AppError {
            error_type: "FFmpegExecutionError".into(),
            message: format!("فشل تشغيل FFmpeg: {}", e),
            details: None,
        })?;

    let stderr = String::from_utf8_lossy(&ffmpeg_output.stderr);
    let stdout = String::from_utf8_lossy(&ffmpeg_output.stdout);
    let full_output = format!("{}\n{}", stdout, stderr);
    parse_silence_output(&full_output)
}

/// قراءة مدة ملف وسائط من ترويسة FFmpeg (سريع — بلا فكّ ترميز)
fn probe_duration(ffmpeg: &str, path: &str) -> Result<f64, AppError> {
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", "-i", path])
        .output()
        .map_err(|e| AppError {
            error_type: "FFmpegError".into(),
            message: format!("فشل فحص المدة: {}", e),
            details: Some(path.to_string()),
        })?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let d = extract_audio_duration(&stderr);
    if d <= 0.0 {
        return Err(AppError {
            error_type: "ProbeError".into(),
            message: "تعذّر قراءة مدة الملف".into(),
            details: Some(path.to_string()),
        });
    }
    Ok(d)
}

// ═══════════════════════════════════════════════════════════════
//  المرحلة 2 — التفريغ الصوتي (Transcription)
// ═══════════════════════════════════════════════════════════════

/// هياكل استجابة الـ API (Groq / OpenAI)
/// تتطابق مع صيغة verbose_json من Whisper

#[derive(Debug, Deserialize)]
struct WhisperApiResponse {
    text: String,
    language: Option<String>,
    words: Option<Vec<WhisperWord>>,
}

#[derive(Debug, Deserialize)]
struct WhisperWord {
    word: String,
    start: f64,
    end: f64,
}

/// 🎙️ تفريغ صوتي عبر Groq API أو OpenAI Whisper
///
/// يرفع ملف الصوت إلى الـ API ويطلب الطوابع الزمنية على مستوى الكلمة.
/// يدعم Groq (سريع ومجاني) أو OpenAI الرسمي.
///
/// # المعاملات
/// - `audio_path`: مسار ملف الصوت المُعالج
/// - `api_key`: مفتاح الـ API (Groq أو OpenAI)
/// - `provider`: "groq" أو "openai"
/// - `model`: اسم الموديل (افتراضي: whisper-large-v3 للـ Groq)
/// - `language`: كود اللغة (افتراضي: "ar" للعربية)
#[tauri::command]
pub async fn transcribe_audio(
    app: tauri::AppHandle,
    audio_path: String,
    api_key: String,
    provider: Option<String>,
    model: Option<String>,
    language: Option<String>,
    additional_vocab: Option<Vec<String>>,
) -> Result<TranscriptionResult, AppError> {
    let provider = provider.unwrap_or_else(|| "groq".to_string());
    let model = model.unwrap_or_else(|| {
        match provider.as_str() {
            "groq" => "whisper-large-v3".to_string(),
            "openai" => "whisper-1".to_string(),
            "speechmatics" => "enhanced".to_string(),
            _ => "whisper-large-v3".to_string(),
        }
    });
    let language = language.unwrap_or_else(|| "ar".to_string());

    log::info!(
        "🎙️ بدء التفريغ الصوتي: {} عبر {} (موديل: {}، لغة: {})",
        audio_path,
        provider,
        model,
        language
    );

    // التحقق من وجود الملف
    if !Path::new(&audio_path).exists() {
        return Err(AppError {
            error_type: "FileNotFound".into(),
            message: "ملف الصوت غير موجود".into(),
            details: Some(audio_path),
        });
    }

    // التحقق من المفتاح
    if api_key.is_empty() {
        return Err(AppError {
            error_type: "MissingApiKey".into(),
            message: "مفتاح الـ API مطلوب".into(),
            details: Some(
                "احصل على مفتاح من console.groq.com أو platform.openai.com أو portal.speechmatics.com".into(),
            ),
        });
    }

    // Speechmatics يستخدم واجهة غير متزامنة (job-based) — مسار منفصل تماماً
    // هنا يُمثّل `model` مستوى المعالجة (enhanced / standard)
    if provider == "speechmatics" {
        let cancel_flag = register_cancel_flag(&app);
        emit_progress(&app, "preparing", 0, 1, 0.0, "رفع الملف إلى Speechmatics...".into());
        return transcribe_speechmatics(
            &app,
            &audio_path,
            &api_key,
            &language,
            &model,
            &cancel_flag,
            additional_vocab.as_deref(),
        )
        .await;
    }

    // تحديد الـ endpoint حسب الـ provider (Whisper-compatible)
    let endpoint = match provider.as_str() {
        "groq" => "https://api.groq.com/openai/v1/audio/transcriptions",
        "openai" => "https://api.openai.com/v1/audio/transcriptions",
        other => {
            return Err(AppError {
                error_type: "InvalidProvider".into(),
                message: format!("مزود غير مدعوم: {}", other),
                details: Some("المزودون المدعومون: groq, openai, speechmatics".into()),
            });
        }
    };

    // علم الإلغاء المشترك (يُضبط عبر الأمر cancel_transcription)
    let cancel_flag = register_cancel_flag(&app);

    // عميل HTTP واحد يُعاد استخدامه لكل القطع
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| AppError {
            error_type: "HttpClientError".into(),
            message: format!("خطأ في إنشاء عميل HTTP: {}", e),
            details: None,
        })?;

    let ffmpeg = check_ffmpeg()?;
    let size_mb = file_size_mb(&audio_path)?;
    let total_duration = probe_duration(&ffmpeg, &audio_path).unwrap_or(0.0);

    // كسر سقف 25MB: قسّم عند حدود الصمت ثم ادمج النتائج (plan.md §0.2).
    // إن فشل قراءة المدة نعتمد المسار المفرد (قد يُرجع الخطأ 413 بوضوح).
    let needs_split = size_mb > 25.0 && total_duration > 1.0;

    let (words, full_text, detected_lang) = if needs_split {
        let chunks = plan_audio_splits(&ffmpeg, &audio_path, total_duration, size_mb)?;
        let total_chunks = chunks.len();
        log::info!(
            "🔪 الملف كبير ({:.1}MB) — قُسّم إلى {} قطعة عند حدود الصمت",
            size_mb,
            total_chunks
        );
        emit_progress(
            &app,
            "preparing",
            0,
            total_chunks,
            0.0,
            format!("تجهيز التفريغ على {} قطعة...", total_chunks),
        );

        let temp_dir = get_temp_dir(&app)?;
        let mut all_words: Vec<WordTimestamp> = Vec::new();
        let mut texts: Vec<String> = Vec::new();
        let mut detected_lang = language.clone();

        for (i, (cstart, cend)) in chunks.iter().enumerate() {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err(cancelled_error());
            }

            let pct = (i as f64 / total_chunks as f64) * 100.0;
            emit_progress(
                &app,
                "transcribing",
                i,
                total_chunks,
                pct,
                format!(
                    "التفريغ: القطعة {} من {} ({}%)",
                    i + 1,
                    total_chunks,
                    pct.round() as u32
                ),
            );

            // 1) استخراج القطعة إلى ملف مؤقت
            let chunk_path =
                split_audio_chunk(&ffmpeg, &audio_path, *cstart, *cend, &temp_dir, i)?;
            // 2) تفريغها
            let result = transcribe_whisper_file(
                &client,
                endpoint,
                &api_key,
                &model,
                &language,
                &chunk_path,
            )
            .await;
            // 3) تنظيف ملف القطعة (بأفضل جهد)
            let _ = std::fs::remove_file(&chunk_path);
            let (mut ws, txt, lang) = result?;

            // 4) إزاحة الطوابع الزمنية بمقدار بداية القطعة
            for w in ws.iter_mut() {
                w.start += cstart;
                w.end += cstart;
            }
            all_words.extend(ws);
            texts.push(txt);
            if let Some(l) = lang {
                detected_lang = l;
            }
        }

        emit_progress(
            &app,
            "merging",
            total_chunks,
            total_chunks,
            100.0,
            "دمج نتائج القطع...".into(),
        );
        (
            all_words,
            texts.join(" ").trim().to_string(),
            detected_lang,
        )
    } else {
        emit_progress(&app, "transcribing", 0, 1, 0.0, "التفريغ الصوتي...".into());
        let (ws, txt, lang) =
            transcribe_whisper_file(&client, endpoint, &api_key, &model, &language, &audio_path)
                .await?;
        (ws, txt, lang.unwrap_or_else(|| language.clone()))
    };

    let word_count = words.len();
    log::info!(
        "✅ تم التفريغ: {} كلمة، المدة: {:.1}s، اللغة: {}",
        word_count,
        total_duration,
        detected_lang
    );

    emit_progress(&app, "done", 1, 1, 100.0, "اكتمل التفريغ".into());

    // حفظ النتيجة في ملف JSON مؤقت للمشروع
    let project_data = save_transcription_to_project(
        &app,
        &audio_path,
        &words,
        &full_text,
        &detected_lang,
        total_duration,
    )?;

    log::info!("💾 تم حفظ بيانات التفريغ في: {}", project_data);

    Ok(TranscriptionResult {
        words,
        full_text,
        language: detected_lang,
        duration: total_duration,
    })
}

// ───────────────────────────────────────────────────────────────
//  التقدّم والإلغاء + تقسيم الملفات الطويلة (plan.md §0.2 / §0.3)
// ───────────────────────────────────────────────────────────────

/// حمولة حدث التقدّم المُصدَر للواجهة (transcribe-progress)
#[derive(Debug, Clone, Serialize)]
struct TranscribeProgress {
    stage: String,
    chunk_index: usize,
    chunk_total: usize,
    percent: f64,
    message: String,
}

/// يسجّل علماً جديداً للإلغاء في الحالة المشتركة ويُعيد نسخة منه.
fn register_cancel_flag(app: &tauri::AppHandle) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Some(state) = app.try_state::<crate::TranscriptionCancel>() {
        *state.0.lock().unwrap() = Some(flag.clone());
    }
    flag
}

/// خطأ الإلغاء الموحّد (تتعامل معه الواجهة كرسالة هادئة لا خطأ)
fn cancelled_error() -> AppError {
    AppError {
        error_type: "Cancelled".into(),
        message: "أُلغي التفريغ".into(),
        details: None,
    }
}

/// إصدار حدث تقدّم للواجهة (يتجاهل الأخطاء بأمان)
fn emit_progress(
    app: &tauri::AppHandle,
    stage: &str,
    chunk_index: usize,
    chunk_total: usize,
    percent: f64,
    message: String,
) {
    let _ = app.emit(
        "transcribe-progress",
        TranscribeProgress {
            stage: stage.to_string(),
            chunk_index,
            chunk_total,
            percent,
            message,
        },
    );
}

/// تفريغ ملف صوتي واحد عبر Whisper-compatible API.
/// يُرجع (الكلمات، النص الكامل، اللغة المكتشفة إن وُجدت).
async fn transcribe_whisper_file(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    model: &str,
    language: &str,
    file_path: &str,
) -> Result<(Vec<WordTimestamp>, String, Option<String>), AppError> {
    let file_bytes = std::fs::read(file_path).map_err(|e| AppError {
        error_type: "FileReadError".into(),
        message: format!("تعذّر قراءة ملف الصوت: {}", e),
        details: Some(file_path.to_string()),
    })?;

    let file_name = get_file_stem(file_path);
    let file_ext = Path::new(file_path)
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_else(|| "mp3".to_string());

    log::info!("رفع الملف ({} bytes) إلى {}...", file_bytes.len(), endpoint);

    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(format!("{}.{}", file_name, file_ext))
        .mime_str(&format!("audio/{}", file_ext))
        .map_err(|e| AppError {
            error_type: "RequestError".into(),
            message: format!("خطأ في بناء الطلب: {}", e),
            details: None,
        })?;

    let form = reqwest::multipart::Form::new()
        .text("model", model.to_string())
        .text("response_format", "verbose_json")
        .text("language", language.to_string())
        .text("timestamp_granularities[]", "word")
        .text("temperature", "0")
        .part("file", part);

    let response = client
        .post(endpoint)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| AppError {
            error_type: "NetworkError".into(),
            message: format!("فشل الاتصال بالـ API: {}", e),
            details: Some(format!(
                "تأكد من اتصال الإنترنت وأن المفتاح صحيح.\nEndpoint: {}",
                endpoint
            )),
        })?;

    let status = response.status();
    log::info!("استجابة الـ API: {}", status);

    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_default();
        log::error!("خطأ من الـ API: {}", error_body);

        let friendly_msg = match status.as_u16() {
            401 => "مفتاح الـ API غير صحيح أو منتهي الصلاحية".to_string(),
            403 => "لا تملك صلاحية الوصول لهذا الموديل".to_string(),
            413 => "حجم القطعة كبير جداً".to_string(),
            429 => "تجاوزت حد الطلبات المسموح. انتظر قليلاً وأعد المحاولة".to_string(),
            500..=599 => "خطأ في خادم الـ API. أعد المحاولة لاحقاً".to_string(),
            _ => format!("خطأ غير متوقع (كود: {})", status.as_u16()),
        };

        return Err(AppError {
            error_type: "ApiError".into(),
            message: friendly_msg,
            details: Some(error_body),
        });
    }

    let api_result: WhisperApiResponse = response
        .json()
        .await
        .map_err(|e| AppError {
            error_type: "ParseError".into(),
            message: format!("تعذّر تحليل استجابة الـ API: {}", e),
            details: None,
        })?;

    let words: Vec<WordTimestamp> = api_result
        .words
        .unwrap_or_default()
        .into_iter()
        .map(|w| WordTimestamp {
            word: w.word.trim().to_string(),
            start: w.start,
            end: w.end,
            // Whisper لا يُرجع درجة ثقة على مستوى الكلمة
            confidence: None,
        })
        .collect();

    let full_text = api_result.text.trim().to_string();
    Ok((words, full_text, api_result.language))
}

/// تخطيط نقاط التقسيم عند حدود الصمت لكسر سقف 25MB (plan.md §0.2).
/// إعادة استخدام لكاشف السكتات: داخل كل نافذة نختار أطول صمت ونقطع عنده.
fn plan_audio_splits(
    ffmpeg: &str,
    audio_path: &str,
    total_duration: f64,
    size_mb: f64,
) -> Result<Vec<(f64, f64)>, AppError> {
    if total_duration <= 1.0 {
        return Ok(vec![(0.0, total_duration)]);
    }
    // 22MB لكل قطعة = هامش أمان تحت سقف 25MB
    let num_chunks = ((size_mb / 22.0).ceil() as usize).max(1);
    let target = (total_duration / num_chunks as f64).max(1.0);

    let silences = run_silence_detect(ffmpeg, audio_path, -30.0, 0.5)?;

    let mut chunks: Vec<(f64, f64)> = Vec::new();
    let mut cursor = 0.0_f64;
    let eps = 0.05;

    while cursor < total_duration - eps {
        let ideal_end = cursor + target;
        if ideal_end >= total_duration - eps {
            chunks.push((cursor, total_duration));
            break;
        }
        // أطول صمت داخل النافذة [cursor, ideal_end]
        let mut best: Option<&SilenceSegment> = None;
        for s in &silences {
            if s.end > cursor && s.start < ideal_end {
                match best {
                    None => best = Some(s),
                    Some(b) if s.duration > b.duration => best = Some(s),
                    _ => {}
                }
            }
        }
        let cut = match best {
            Some(s) => {
                let mid = (s.start + s.end) / 2.0;
                // اضمن تقدّماً حقيقياً وابقَ داخل النافذة
                mid.max(cursor + 1.0).min(ideal_end)
            }
            None => ideal_end,
        };
        chunks.push((cursor, cut));
        cursor = cut;
    }

    if chunks.is_empty() {
        chunks.push((0.0, total_duration));
    }
    Ok(chunks)
}

/// استخراج قطعة صوتية [start, end] إلى ملف مؤقت.
/// نسخ مباشر (-c copy) أولاً، ومع الفشل إعادة ترميز احتياطية.
fn split_audio_chunk(
    ffmpeg: &str,
    audio_path: &str,
    start: f64,
    end: f64,
    temp_dir: &Path,
    index: usize,
) -> Result<String, AppError> {
    let out = temp_dir.join(format!("chunk_{}.mp3", index));
    let out_str = out.to_string_lossy().to_string();
    let duration = (end - start).max(0.0);

    let run = |reencode: bool| -> std::io::Result<std::process::Output> {
        let mut cmd = Command::new(ffmpeg);
        cmd.args([
            "-ss",
            &format!("{:.3}", start),
            "-i",
            audio_path,
            "-t",
            &format!("{:.3}", duration),
        ]);
        if reencode {
            cmd.args(["-acodec", "libmp3lame", "-ab", "128k", "-ar", "44100"]);
        } else {
            cmd.args(["-c", "copy"]);
        }
        cmd.args(["-y", &out_str]);
        cmd.output()
    };

    let output = run(false).map_err(|e| AppError {
        error_type: "FFmpegExecutionError".into(),
        message: format!("فشل تقسيم الصوت: {}", e),
        details: None,
    })?;

    if !output.status.success() {
        let output = run(true).map_err(|e| AppError {
            error_type: "FFmpegExecutionError".into(),
            message: format!("فشل تقسيم الصوت: {}", e),
            details: None,
        })?;
        if !output.status.success() {
            return Err(AppError {
                error_type: "SplitError".into(),
                message: "تعذّر تقسيم ملف الصوت".into(),
                details: Some(String::from_utf8_lossy(&output.stderr).to_string()),
            });
        }
    }
    Ok(out_str)
}

/// ✋ إلغاء التفريغ الجاري — يضبط العلم المشترك فيستيقظ حلقة القطع.
#[tauri::command]
pub async fn cancel_transcription(app: tauri::AppHandle) -> Result<(), AppError> {
    if let Some(state) = app.try_state::<crate::TranscriptionCancel>() {
        if let Some(flag) = state.0.lock().unwrap().as_ref() {
            flag.store(true, Ordering::SeqCst);
            log::info!("✋ طُلب إلغاء التفريغ");
        }
    }
    Ok(())
}

// ───────────────────────────────────────────────────────────────
//  Speechmatics (Batch API — json-v2)
// ───────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct SpeechmaticsJobCreated {
    id: String,
}

#[derive(Debug, Deserialize)]
struct SpeechmaticsJobStatus {
    job: SpeechmaticsJobDetails,
}

#[derive(Debug, Deserialize)]
struct SpeechmaticsJobDetails {
    status: String,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    errors: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
struct SpeechmaticsTranscript {
    #[serde(default)]
    results: Vec<SpeechmaticsResultItem>,
}

#[derive(Debug, Deserialize)]
struct SpeechmaticsResultItem {
    #[serde(rename = "type")]
    item_type: String,
    #[serde(default)]
    start_time: Option<f64>,
    #[serde(default)]
    end_time: Option<f64>,
    #[serde(default)]
    alternatives: Vec<SpeechmaticsAlternative>,
}

#[derive(Debug, Deserialize)]
struct SpeechmaticsAlternative {
    content: String,
    /// درجة ثقة النموذج بالكلمة (0.0 - 1.0) — ترسلها Speechmatics في json-v2
    #[serde(default)]
    confidence: Option<f32>,
}

/// 🎙️ تفريغ صوتي عبر Speechmatics (Batch API غير متزامن)
///
/// على عكس Whisper (طلب واحد متزامن)، Speechmatics تعمل على شكل مهمة (job):
///   1. رفع الملف + الإعدادات ← الحصول على معرّف المهمة
///   2. الاستعلام الدوري عن حالة المهمة حتى تصبح "done"
///   3. جلب النص المُفرّغ بصيغة json-v2 (يتضمن طوابع زمنية على مستوى الكلمة)
///
/// قد يستغرق التفريغ عدة دقائق حسب طول الملف.
async fn transcribe_speechmatics(
    app: &tauri::AppHandle,
    audio_path: &str,
    api_key: &str,
    language: &str,
    operating_point: &str,
    cancel_flag: &Arc<AtomicBool>,
    additional_vocab: Option<&[String]>,
) -> Result<TranscriptionResult, AppError> {
    const BASE_URL: &str = "https://asr.api.speechmatics.com/v2";

    // Speechmatics يقبل فقط standard أو enhanced
    let op = match operating_point {
        "standard" | "enhanced" => operating_point,
        _ => "enhanced",
    };

    log::info!(
        "🎙️ Speechmatics: بدء التفريغ (لغة: {}، المستوى: {})",
        language,
        op
    );

    // قراءة ملف الصوت
    let file_bytes = std::fs::read(audio_path).map_err(|e| AppError {
        error_type: "FileReadError".into(),
        message: format!("تعذّر قراءة ملف الصوت: {}", e),
        details: Some(audio_path.to_string()),
    })?;

    let file_name = get_file_stem(audio_path);
    let file_ext = Path::new(audio_path)
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_else(|| "mp3".to_string());

    // إعدادات المهمة (config JSON)
    // additional_vocab: حقن قاموس المستخدم في النموذج قبل التفريغ (plan.md §3.1).
    let mut transcription_config = serde_json::json!({
        "language": language,
        "operating_point": op
    });
    if let Some(vocab) = additional_vocab {
        if !vocab.is_empty() {
            let items: Vec<serde_json::Value> = vocab
                .iter()
                .map(|s| serde_json::json!({ "content": s }))
                .collect();
            transcription_config["additional_vocab"] = serde_json::json!(items);
        }
    }
    let config = serde_json::json!({
        "type": "transcription",
        "transcription_config": transcription_config
    })
    .to_string();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| AppError {
            error_type: "HttpClientError".into(),
            message: format!("خطأ في إنشاء عميل HTTP: {}", e),
            details: None,
        })?;

    // ═══ 1) رفع الملف وإنشاء المهمة ═══
    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(format!("{}.{}", file_name, file_ext))
        .mime_str(&format!("audio/{}", file_ext))
        .map_err(|e| AppError {
            error_type: "RequestError".into(),
            message: format!("خطأ في بناء الطلب: {}", e),
            details: None,
        })?;

    let form = reqwest::multipart::Form::new()
        .text("config", config)
        .part("data_file", part);

    log::info!("Speechmatics: رفع الملف وإنشاء المهمة...");

    let create_resp = client
        .post(format!("{}/jobs", BASE_URL))
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| AppError {
            error_type: "NetworkError".into(),
            message: format!("فشل الاتصال بـ Speechmatics: {}", e),
            details: None,
        })?;

    let status = create_resp.status();
    if !status.is_success() {
        let body = create_resp.text().await.unwrap_or_default();
        let friendly = match status.as_u16() {
            401 | 403 => "مفتاح Speechmatics API غير صحيح أو منتهي الصلاحية".to_string(),
            429 => "تجاوزت حد الطلبات المسموح في Speechmatics".to_string(),
            _ => format!("خطأ من Speechmatics (كود: {})", status.as_u16()),
        };
        return Err(AppError {
            error_type: "ApiError".into(),
            message: friendly,
            details: Some(body),
        });
    }

    let created: SpeechmaticsJobCreated = create_resp.json().await.map_err(|e| AppError {
        error_type: "ParseError".into(),
        message: format!("تعذّر قراءة معرّف مهمة Speechmatics: {}", e),
        details: None,
    })?;

    let job_id = created.id;
    log::info!("Speechmatics: تم إنشاء المهمة {}", job_id);

    // ═══ 2) الاستعلام الدوري حتى الاكتمال ═══
    const POLL_INTERVAL_SECS: u64 = 5;
    const MAX_POLL_ATTEMPTS: u32 = 360; // 360 × 5s = 30 دقيقة كحد أقصى
    let mut job_duration = 0.0_f64;
    let mut done = false;

    for attempt in 0..MAX_POLL_ATTEMPTS {
        if cancel_flag.load(Ordering::SeqCst) {
            return Err(cancelled_error());
        }
        tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;

        // مؤشّر تقدّم تقريبي خلال الاستعلام الدوري
        if attempt % 3 == 0 {
            emit_progress(
                app,
                "transcribing",
                attempt as usize,
                MAX_POLL_ATTEMPTS as usize,
                ((attempt as f64 / MAX_POLL_ATTEMPTS as f64) * 100.0).min(95.0),
                format!("يعالج Speechmatics المهمة... ({}ث)", attempt as u64 * POLL_INTERVAL_SECS),
            );
        }

        let status_resp = client
            .get(format!("{}/jobs/{}", BASE_URL, job_id))
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|e| AppError {
                error_type: "NetworkError".into(),
                message: format!("فشل الاستعلام عن حالة المهمة: {}", e),
                details: None,
            })?;

        if !status_resp.status().is_success() {
            let body = status_resp.text().await.unwrap_or_default();
            return Err(AppError {
                error_type: "ApiError".into(),
                message: "فشل الاستعلام عن حالة مهمة Speechmatics".into(),
                details: Some(body),
            });
        }

        let job_status: SpeechmaticsJobStatus =
            status_resp.json().await.map_err(|e| AppError {
                error_type: "ParseError".into(),
                message: format!("تعذّر تحليل حالة المهمة: {}", e),
                details: None,
            })?;

        job_duration = job_status.job.duration.unwrap_or(job_duration);

        match job_status.job.status.as_str() {
            "done" => {
                log::info!("✅ Speechmatics: اكتملت المهمة {}", job_id);
                done = true;
                break;
            }
            "rejected" | "deleted" | "expired" => {
                return Err(AppError {
                    error_type: "ApiError".into(),
                    message: format!(
                        "رُفضت مهمة Speechmatics (الحالة: {})",
                        job_status.job.status
                    ),
                    details: job_status.job.errors.map(|e| format!("{:?}", e)),
                });
            }
            other => {
                if attempt % 6 == 0 {
                    log::info!(
                        "Speechmatics: المهمة قيد المعالجة ({})... {}s",
                        other,
                        attempt as u64 * POLL_INTERVAL_SECS
                    );
                }
            }
        }
    }

    if !done {
        return Err(AppError {
            error_type: "Timeout".into(),
            message: "انتهت مهلة انتظار Speechmatics (30 دقيقة)".into(),
            details: Some(format!("معرّف المهمة: {}", job_id)),
        });
    }

    // ═══ 3) جلب النص المُفرّغ (json-v2) ═══
    let transcript_resp = client
        .get(format!("{}/jobs/{}/transcript?format=json-v2", BASE_URL, job_id))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| AppError {
            error_type: "NetworkError".into(),
            message: format!("فشل جلب نص Speechmatics: {}", e),
            details: None,
        })?;

    if !transcript_resp.status().is_success() {
        let body = transcript_resp.text().await.unwrap_or_default();
        return Err(AppError {
            error_type: "ApiError".into(),
            message: "فشل جلب النص المُفرّغ من Speechmatics".into(),
            details: Some(body),
        });
    }

    let transcript: SpeechmaticsTranscript =
        transcript_resp.json().await.map_err(|e| AppError {
            error_type: "ParseError".into(),
            message: format!("تعذّر تحليل نص Speechmatics: {}", e),
            details: None,
        })?;

    // تحويل النتائج إلى كلمات مع إلصاق علامات الترقيم بنصّ آخر كلمة
    // (التقاط مجاني — plan.md §2.2: توكنات Speechmatics للترقيم مستقلة).
    let mut words: Vec<WordTimestamp> = Vec::new();
    for item in &transcript.results {
        match item.item_type.as_str() {
            "word" => {
                let alt = item.alternatives.first();
                let content = alt.map(|a| a.content.trim().to_string()).unwrap_or_default();
                if content.is_empty() {
                    continue;
                }
                words.push(WordTimestamp {
                    word: content,
                    start: item.start_time.unwrap_or(0.0),
                    end: item.end_time.unwrap_or(0.0),
                    // درجة الثقة كما وردت (البديل الأول = الأرجح)، مقيّدة في [0,1]
                    confidence: alt
                        .and_then(|a| a.confidence)
                        .filter(|c| c.is_finite())
                        .map(|c| c.clamp(0.0, 1.0)),
                });
            }
            "punctuation" => {
                // ألصق الترقيم بنصّ آخر كلمة (مثل «قال:»)
                let punct = item
                    .alternatives
                    .first()
                    .map(|a| a.content.trim().to_string())
                    .unwrap_or_default();
                if !punct.is_empty() {
                    if let Some(last) = words.last_mut() {
                        last.word.push_str(&punct);
                    }
                }
            }
            _ => {}
        }
    }

    // النص الكامل: نجمّعه من الكلمات (بترقيمها) لضمان تطابق 1:1 معها،
    // فتتم محاذاتها لاحقًا في الواجهة بأمان.
    let full_text = words
        .iter()
        .map(|w| w.word.clone())
        .collect::<Vec<_>>()
        .join(" ");

    // المدة: من المهمة، وإلا نهاية آخر كلمة
    let duration = if job_duration > 0.0 {
        job_duration
    } else {
        words.last().map(|w| w.end).unwrap_or(0.0)
    };

    log::info!(
        "✅ Speechmatics: {} كلمة، المدة: {:.1}s",
        words.len(),
        duration
    );

    emit_progress(app, "done", 1, 1, 100.0, "اكتمل التفريغ".into());

    let project_data =
        save_transcription_to_project(app, audio_path, &words, &full_text, language, duration)?;
    log::info!("💾 تم حفظ بيانات التفريغ في: {}", project_data);

    Ok(TranscriptionResult {
        words,
        full_text,
        language: language.to_string(),
        duration,
    })
}

/// حفظ نتيجة التفريغ في ملف JSON ضمن مجلد المشروع المؤقت
fn save_transcription_to_project(
    app: &tauri::AppHandle,
    audio_path: &str,
    words: &[WordTimestamp],
    full_text: &str,
    language: &str,
    duration: f64,
) -> Result<String, AppError> {
    let temp_dir = get_temp_dir(app)?;
    let stem = get_file_stem(audio_path);

    let project_json = serde_json::json!({
        "version": "2.0",
        "source_audio": audio_path,
        "language": language,
        "duration_sec": duration,
        "word_count": words.len(),
        "full_text": full_text,
        "words": words.iter().map(|w| {
            let mut obj = serde_json::json!({
                "word": w.word,
                "start": w.start,
                "end": w.end,
            });
            // نكتب الثقة فقط عند توفّرها (Speechmatics) لإبقاء الملف نظيفاً
            if let Some(c) = w.confidence {
                obj["confidence"] = serde_json::json!(c);
            }
            obj
        }).collect::<Vec<_>>(),
        "created_at": chrono::Utc::now().to_rfc3339(),
    });

    let project_path = temp_dir.join(format!("{}_transcript.json", stem));
    let project_str = serde_json::to_string_pretty(&project_json).map_err(|e| AppError {
        error_type: "SerializationError".into(),
        message: format!("خطأ في تحويل البيانات لـ JSON: {}", e),
        details: None,
    })?;

    std::fs::write(&project_path, project_str).map_err(|e| AppError {
        error_type: "FileWriteError".into(),
        message: format!("تعذّر حفظ ملف التفريغ: {}", e),
        details: Some(project_path.to_string_lossy().to_string()),
    })?;

    Ok(project_path.to_string_lossy().to_string())
}

// ═══════════════════════════════════════════════════════════════
//  المرحلة 4 — التصدير النهائي (Export Video)
// ═══════════════════════════════════════════════════════════════

/// 🎬 تصدير الفيديو النهائي بعد إزالة الأجزاء المحذوفة
///
/// يستخدم فلاتر `trim`/`atrim` + `concat` في FFmpeg لإزالة الفترات المحذوفة
/// من الفيديو مع الحفاظ على تزامن الصوت والصورة.
///
/// # الخوارزمية
/// 1. بناء تعبير `select` يستبعد كل الفترات المحذوفة
/// 2. إعادة ضبط PTS لتسريع الإطارات المتبقية
/// 3. ترميز نهائي بجودة عالية (H.264 + AAC)
///
/// # المعاملات
/// - `video_path`: مسار الفيديو الأصلي
/// - `excluded_ranges`: الفترات المحذوفة [{start, end}, ...]
#[tauri::command]
pub async fn export_video(
    app: tauri::AppHandle,
    video_path: String,
    excluded_ranges: Vec<TimeRange>,
    output_dir: Option<String>,
) -> Result<ExportResult, AppError> {
    let ffmpeg = check_ffmpeg()?;

    if !Path::new(&video_path).exists() {
        return Err(AppError {
            error_type: "FileNotFound".into(),
            message: "ملف الفيديو غير موجود".into(),
            details: Some(video_path),
        });
    }

    log::info!(
        "🎬 بدء التصدير: {} ({} مقطع محذوف)",
        video_path,
        excluded_ranges.len()
    );

    if excluded_ranges.is_empty() {
        return Err(AppError {
            error_type: "NothingToExport".into(),
            message: "لا توجد أجزاء محذوفة. الفيديو الأصلي بحالته".into(),
            details: Some("حدّد كلمات أو سكتات للحذف ثم أعد التصدير".into()),
        });
    }

    // ─── فحص الملف: المدة الكلية + وجود مسار صوتي ────────────────
    let (input_duration, has_audio) = probe_media(&ffmpeg, &video_path)?;

    // ─── ترتيب الفترات المحذوفة ودمج المتداخل وقصّها على حدود الفيديو ──
    let mut sorted = excluded_ranges.clone();
    sorted.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));

    let mut merged: Vec<TimeRange> = Vec::new();
    for r in sorted {
        let start = r.start.max(0.0);
        let end = r.end.min(input_duration);
        if end <= start {
            continue;
        }
        match merged.last_mut() {
            Some(last) if start <= last.end + 0.001 => {
                last.end = last.end.max(end);
            }
            _ => merged.push(TimeRange { start, end }),
        }
    }

    // ─── حساب الأجزاء المُبقاة (مكمّل الفترات المحذوفة) ───────────
    // نستخدم trim/atrim + concat بدل select/aselect لأن aselect
    // لا يُسقط عينات الصوت في بعض نسخ FFmpeg (لوحظ في 8.0) —
    // فينتج فيديو مقصوص وصوت كامل غير متزامن.
    const MIN_SEGMENT: f64 = 0.01; // تجاهل أجزاء أقصر من 10ms
    let mut keep: Vec<TimeRange> = Vec::new();
    let mut cursor = 0.0_f64;
    for r in &merged {
        if r.start > cursor + MIN_SEGMENT {
            keep.push(TimeRange { start: cursor, end: r.start });
        }
        cursor = cursor.max(r.end);
    }
    if input_duration > cursor + MIN_SEGMENT {
        keep.push(TimeRange { start: cursor, end: input_duration });
    }

    if keep.is_empty() {
        return Err(AppError {
            error_type: "NothingLeft".into(),
            message: "كل مدة الفيديو محددة للحذف — لا يوجد ما يُصدَّر".into(),
            details: None,
        });
    }

    // ─── تحديد مجلد الإخراج (يختاره المستخدم، وإلا الكاش) ─────────
    // temp_dir للملفات الوسيطة (ملف الفلتر)، والمخرَج النهائي يتبع اختيار المستخدم
    let temp_dir = get_temp_dir(&app)?;
    let out_dir_str: String = match output_dir.as_deref() {
        Some(d) if !d.is_empty() && Path::new(d).is_dir() => d.to_string(),
        _ => temp_dir.to_string_lossy().to_string(),
    };
    let stem = get_file_stem(&video_path);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let output_name = format!("{}_edited_{}.mp4", stem, timestamp);
    let output_path = PathBuf::from(&out_dir_str).join(&output_name);
    let output_str = output_path.to_string_lossy().to_string();

    // ─── حساب المدة المحذوفة فعلياً ──────────────────────────────
    let kept_duration: f64 = keep.iter().map(|r| r.end - r.start).sum();
    let total_excluded = (input_duration - kept_duration).max(0.0);

    log::info!(
        "عدد الأجزاء المُبقاة: {} — حذف {:.1}s من {:.1}s (trim/concat)",
        keep.len(),
        total_excluded,
        input_duration
    );

    // ─── بناء فلتر trim/atrim + concat ───────────────────────────
    // يُكتب في ملف (filter_complex_script) لتفادي حدود طول سطر الأوامر
    // في ويندوز عند كثرة الأجزاء.
    let mut filter = String::new();
    for (i, seg) in keep.iter().enumerate() {
        filter.push_str(&format!(
            "[0:v]trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS[v{}];\n",
            seg.start, seg.end, i
        ));
        if has_audio {
            filter.push_str(&format!(
                "[0:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS[a{}];\n",
                seg.start, seg.end, i
            ));
        }
    }
    for i in 0..keep.len() {
        filter.push_str(&format!("[v{}]", i));
        if has_audio {
            filter.push_str(&format!("[a{}]", i));
        }
    }
    filter.push_str(&format!(
        "concat=n={}:v=1:a={}[outv]",
        keep.len(),
        if has_audio { 1 } else { 0 }
    ));
    if has_audio {
        filter.push_str("[outa]");
    }

    let filter_script = temp_dir.join(format!("filter_{}.txt", timestamp));
    let filter_script_str = filter_script.to_string_lossy().to_string();
    std::fs::write(&filter_script, &filter).map_err(|e| AppError {
        error_type: "FilterScriptError".into(),
        message: format!("تعذّر كتابة ملف الفلتر: {}", e),
        details: Some(filter_script_str.clone()),
    })?;

    // ─── تشغيل FFmpeg ────────────────────────────────────────────
    let mut args: Vec<&str> = vec![
        "-i", &video_path,
        "-filter_complex_script", &filter_script_str,
        "-map", "[outv]",
    ];
    if has_audio {
        args.extend_from_slice(&["-map", "[outa]", "-c:a", "aac", "-b:a", "192k"]);
    }
    args.extend_from_slice(&[
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "20",
        "-movflags", "+faststart",
        "-y",
        &output_str,
    ]);

    let ffmpeg_result = Command::new(&ffmpeg).args(&args).output();

    // تنظيف ملف الفلتر المؤقت (بأفضل جهد)
    let _ = std::fs::remove_file(&filter_script);

    let ffmpeg_output = ffmpeg_result.map_err(|e| AppError {
        error_type: "FFmpegExecutionError".into(),
        message: format!("فشل تشغيل FFmpeg: {}", e),
        details: None,
    })?;

    if !ffmpeg_output.status.success() {
        let stderr = String::from_utf8_lossy(&ffmpeg_output.stderr);
        log::error!("FFmpeg export stderr: {}", stderr);

        let friendly = if stderr.contains("No such filter") {
            "نسخة FFmpeg لا تدعم الفلاتر المطلوبة".to_string()
        } else if stderr.contains("Invalid data") {
            "ملف الفيديو تالف".to_string()
        } else {
            format!("خطأ أثناء التصدير (كود: {:?})", ffmpeg_output.status.code())
        };

        return Err(AppError {
            error_type: "ExportError".into(),
            message: friendly,
            details: Some(stderr.to_string()),
        });
    }

    let output_size = file_size_mb(&output_str)?;

    // ─── قراءة المدة النهائية من ترويسة الملف الناتج ─────────────
    let final_duration = probe_media(&ffmpeg, &output_str)
        .map(|(d, _)| d)
        .unwrap_or(kept_duration);

    log::info!(
        "✅ تم التصدير: {} ({:.2} MB, {:.1}s)",
        output_str,
        output_size,
        final_duration
    );

    Ok(ExportResult {
        success: true,
        output_path: output_str,
        output_size_mb: output_size,
        original_duration: input_duration,
        final_duration,
        message: format!(
            "تم تصدير الفيديو بنجاح ({:.2} MB) — تمت إزالة {:.1} ثانية",
            output_size, total_excluded
        ),
    })
}

/// فحص ملف وسائط: يقرأ المدة ووجود مسار صوتي من ترويسة الملف
/// (سريع — بلا فك ترميز؛ `ffmpeg -i` بلا مخرجات يطبع الترويسة في stderr)
fn probe_media(ffmpeg: &str, path: &str) -> Result<(f64, bool), AppError> {
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", "-i", path])
        .output()
        .map_err(|e| AppError {
            error_type: "FFmpegError".into(),
            message: format!("فشل فحص الملف: {}", e),
            details: Some(path.to_string()),
        })?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let duration_re = Regex::new(r"Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)")
        .unwrap();

    let duration = duration_re
        .captures(&stderr)
        .map(|caps| {
            let h: f64 = caps[1].parse().unwrap_or(0.0);
            let m: f64 = caps[2].parse().unwrap_or(0.0);
            let s: f64 = caps[3].parse().unwrap_or(0.0);
            h * 3600.0 + m * 60.0 + s
        })
        .ok_or_else(|| AppError {
            error_type: "ProbeError".into(),
            message: "تعذّر قراءة مدة الفيديو".into(),
            details: Some(path.to_string()),
        })?;

    let has_audio = stderr.contains("Audio:");

    Ok((duration, has_audio))
}

// ═══════════════════════════════════════════════════════════════
//  المرحلة 4 — توليد Shorts الذكي (LLM Agent)
// ═══════════════════════════════════════════════════════════════

/// 🤖 توليد اقتراحات مقاطع قصيرة (Shorts) عبر LLM
///
/// يرسل النص الكامل للفيديو مع الطوابع الزمنية إلى GPT-4o أو Claude،
/// ويطلب اختيار أفضل اللحظات التي تصلح كمقطع قصير (≤60 ثانية).
///
/// # المعاملات
/// - `transcript_json`: JSON يحتوي على [{word, start, end}, ...]
/// - `api_key`: مفتاح الـ API
/// - `provider`: "openai" أو "anthropic"
/// - `model`: اسم الموديل (افتراضي: gpt-4o)
#[tauri::command]
pub async fn generate_shorts(
    transcript_json: String,
    api_key: String,
    provider: Option<String>,
    model: Option<String>,
    system_prompt: Option<String>,
) -> Result<Vec<ShortSuggestion>, AppError> {
    let provider = provider.unwrap_or_else(|| "openai".to_string());
    let model = model.unwrap_or_else(|| {
        match provider.as_str() {
            "anthropic" => "claude-sonnet-4-20250514".to_string(),
            "gemini" => "gemini-2.5-flash".to_string(),
            _ => "gpt-4o".to_string(),
        }
    });

    log::info!("🤖 توليد Shorts عبر {} (موديل: {})", provider, model);

    if api_key.is_empty() {
        return Err(AppError {
            error_type: "MissingApiKey".into(),
            message: "مفتاح الـ API مطلوب لتوليد Shorts".into(),
            details: None,
        });
    }

    // ─── تحليل transcript_json إلى جمل مع طوابع زمنية ───────────
    let sentences = build_sentences_from_transcript(&transcript_json)?;
    log::info!("عدد الجمل المستخرجة: {}", sentences.len());

    if sentences.is_empty() {
        return Err(AppError {
            error_type: "EmptyTranscript".into(),
            message: "لا يوجد نص كافٍ لتوليد Shorts".into(),
            details: None,
        });
    }

    // ─── بناء النص المُرسل للـ LLM ───────────────────────────────
    let mut transcript_for_llm = String::new();
    for s in &sentences {
        transcript_for_llm.push_str(&format!(
            "[{:.1}s - {:.1}s] {}\n",
            s.start, s.end, s.text
        ));
    }

    let system_prompt = match system_prompt {
        Some(p) if !p.trim().is_empty() => p,
        _ => build_shorts_system_prompt(),
    };
    let user_prompt = format!(
        "إليك تفريغ فيديو بالعربية، كل سطر يحتوي على الفترة الزمنية والنص:\n\n\
        {}\n\n\
        اختر أفضل 3 إلى 5 لحظات تصلح لمقاطع قصيرة (Shorts/Reels/TikTok). \
        ردّ بصيغة JSON فقط بدون أي نص إضافي.",
        transcript_for_llm
    );

    // ─── استدعاء الـ API ─────────────────────────────────────────
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| AppError {
            error_type: "HttpClientError".into(),
            message: format!("خطأ في إنشاء عميل HTTP: {}", e),
            details: None,
        })?;

    let raw_response = match provider.as_str() {
        "anthropic" => {
            call_anthropic(&client, &api_key, &model, &system_prompt, &user_prompt).await?
        }
        "gemini" => {
            call_gemini(&client, &api_key, &model, &system_prompt, &user_prompt).await?
        }
        _ => {
            call_openai(&client, &api_key, &model, &system_prompt, &user_prompt).await?
        }
    };

    log::info!("استجابة الـ LLM: {} bytes", raw_response.len());

    // ─── تحليل JSON من الرد ──────────────────────────────────────
    let suggestions = parse_shorts_json(&raw_response)?;

    log::info!("✅ تم اقتراح {} مقطع قصير", suggestions.len());
    for s in &suggestions {
        log::info!("  📌 {} ({:.1}s - {:.1}s)", s.title, s.start, s.end);
    }

    Ok(suggestions)
}

/// بناء جمل من كلمات التفريغ (تجميع حسب فواصل زمنية أو نهايات جمل)
#[derive(Debug)]
struct Sentence {
    text: String,
    start: f64,
    end: f64,
}

fn build_sentences_from_transcript(json_str: &str) -> Result<Vec<Sentence>, AppError> {
    #[derive(Deserialize)]
    struct WordItem {
        word: String,
        start: f64,
        end: f64,
    }
    #[derive(Deserialize)]
    struct TranscriptData {
        #[serde(default)]
        words: Vec<WordItem>,
    }

    let data: TranscriptData = serde_json::from_str(json_str).map_err(|e| AppError {
        error_type: "ParseError".into(),
        message: format!("تعذّر تحليل بيانات التفريغ: {}", e),
        details: None,
    })?;

    let mut sentences: Vec<Sentence> = Vec::new();
    let mut current_text = String::new();
    let mut current_start = 0.0;
    let mut current_end = 0.0;

    for word in &data.words {
        if current_text.is_empty() {
            current_start = word.start;
        }

        current_text.push_str(&word.word);
        current_text.push(' ');
        current_end = word.end;

        // نهاية جملة: نقطة، علامة استفهام، فاصل زمني طويل
        let ends_sentence = word.word.ends_with('.')
            || word.word.ends_with('؟')
            || word.word.ends_with('!')
            || word.word.ends_with(':')
            || word.word.ends_with('؛');

        let gap = if !sentences.is_empty() {
            word.start - current_end
        } else {
            0.0
        };

        if ends_sentence || gap > 1.5 {
            sentences.push(Sentence {
                text: current_text.trim().to_string(),
                start: current_start,
                end: current_end,
            });
            current_text.clear();
        }
    }

    // آخر جملة متبقية
    if !current_text.trim().is_empty() {
        sentences.push(Sentence {
            text: current_text.trim().to_string(),
            start: current_start,
            end: current_end,
        });
    }

    Ok(sentences)
}

/// البرومبت الموجّه للـ LLM لاختيار أفضل اللحظات
fn build_shorts_system_prompt() -> String {
    r#"أنت محرر فيديو محترف متخصص في المحتوى العربي لمنصات Shorts و Reels و TikTok.

مهمتك: تحليل تفريغ فيديو واختيار أفضل اللحظات التي تصلح كمقاطع قصيرة جذابة.

## المعايير:
1. المدة: كل مقطع يجب ألا يتجاوز 60 ثانية ولا يقل عن 10 ثوانٍ
2. الجاذبية: اختر اللحظات الحماسية، المفيدة، أو التي تحتوي على معلومات قيّمة
3. الاكتمال: المقطع يجب أن يكون مكتمل المعنى (بداية ونهاية طبيعية)
4. العنوان: عنوان جذّاب بالعربية يصف المحتوى في 3-7 كلمات
5. السبب: اشرح باختصار لماذا هذا المقطع جيد

## قيود صارمة:
- أعد فقط JSON صالح بدون أي نص قبله أو بعده
- لا تستخدم markdown code blocks
- الأرقام يجب أن تطابق الطوابع الزمنية المُعطاة

## صيغة الإخراج المطلوبة بالضبط:
[
  {
    "title": "عنوان جذّاب بالعربية",
    "start": 12.5,
    "end": 58.3,
    "reason": "شرح موجز لجاذبية المقطع"
  }
]

اختر 3 إلى 5 مقاطع من أفضل اللحظات في الفيديو."#.to_string()
}

/// استدعاء OpenAI API (GPT-4o)
async fn call_openai(
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, AppError> {
    let body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "temperature": 0.7,
        "max_tokens": 8192,
    });

    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError {
            error_type: "NetworkError".into(),
            message: format!("فشل الاتصال بـ OpenAI: {}", e),
            details: None,
        })?;

    let status = response.status();
    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_default();
        let friendly = match status.as_u16() {
            401 => "مفتاح OpenAI API غير صحيح",
            429 => "تجاوزت حد الطلبات",
            _ => "خطأ في خادم OpenAI",
        };
        return Err(AppError {
            error_type: "ApiError".into(),
            message: friendly.into(),
            details: Some(error_body),
        });
    }

    #[derive(Deserialize)]
    struct OpenAiResponse {
        choices: Vec<OpenAiChoice>,
    }
    #[derive(Deserialize)]
    struct OpenAiChoice {
        message: OpenAiMessage,
    }
    #[derive(Deserialize)]
    struct OpenAiMessage {
        content: String,
    }

    let resp: OpenAiResponse = response
        .json()
        .await
        .map_err(|e| AppError {
            error_type: "ParseError".into(),
            message: format!("تعذّر تحليل استجابة OpenAI: {}", e),
            details: None,
        })?;

    Ok(resp
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .unwrap_or_default())
}

/// استدعاء Gemini API (عبر واجهة Google المتوافقة مع OpenAI)
async fn call_gemini(
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, AppError> {
    const GEMINI_ENDPOINT: &str =
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "temperature": 0.7,
        // نرفع السقف لتجنّب اقتطاع JSON في المخرجات الطويلة
        "max_tokens": 8192,
    });

    // موديلات 2.5 تفكيرية؛ يُستهلك جزء من الميزانية في التفكير فيُقتَطع الإخراج.
    // نحدّ من التفكير لضمان اكتمال JSON (تُدعم reasoning_effort فقط في موديلات التفكير).
    if model.contains("2.5") {
        body["reasoning_effort"] = serde_json::json!("low");
    }

    let response = client
        .post(GEMINI_ENDPOINT)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError {
            error_type: "NetworkError".into(),
            message: format!("فشل الاتصال بـ Gemini: {}", e),
            details: None,
        })?;

    let status = response.status();
    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_default();
        let friendly = match status.as_u16() {
            400 => "طلب غير صالح لـ Gemini (تحقّق من اسم الموديل)",
            401 | 403 => "مفتاح Gemini API غير صحيح",
            429 => "تجاوزت حد الطلبات في Gemini",
            _ => "خطأ في خادم Gemini",
        };
        return Err(AppError {
            error_type: "ApiError".into(),
            message: friendly.into(),
            details: Some(error_body),
        });
    }

    #[derive(Deserialize)]
    struct GeminiResponse {
        choices: Vec<GeminiChoice>,
    }
    #[derive(Deserialize)]
    struct GeminiChoice {
        message: GeminiMessage,
    }
    #[derive(Deserialize)]
    struct GeminiMessage {
        content: String,
    }

    let resp: GeminiResponse = response.json().await.map_err(|e| AppError {
        error_type: "ParseError".into(),
        message: format!("تعذّر تحليل استجابة Gemini: {}", e),
        details: None,
    })?;

    Ok(resp
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .unwrap_or_default())
}

/// استدعاء Anthropic API (Claude)
async fn call_anthropic(
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, AppError> {
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 8192,
        "system": system_prompt,
        "messages": [
            {"role": "user", "content": user_prompt}
        ]
    });

    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError {
            error_type: "NetworkError".into(),
            message: format!("فشل الاتصال بـ Anthropic: {}", e),
            details: None,
        })?;

    let status = response.status();
    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_default();
        let friendly = match status.as_u16() {
            401 => "مفتاح Anthropic API غير صحيح",
            429 => "تجاوزت حد الطلبات",
            _ => "خطأ في خادم Anthropic",
        };
        return Err(AppError {
            error_type: "ApiError".into(),
            message: friendly.into(),
            details: Some(error_body),
        });
    }

    #[derive(Deserialize)]
    struct AnthropicResponse {
        content: Vec<AnthropicContent>,
    }
    #[derive(Deserialize)]
    struct AnthropicContent {
        #[serde(rename = "type")]
        content_type: String,
        text: Option<String>,
    }

    let resp: AnthropicResponse = response
        .json()
        .await
        .map_err(|e| AppError {
            error_type: "ParseError".into(),
            message: format!("تعذّر تحليل استجابة Anthropic: {}", e),
            details: None,
        })?;

    let text = resp
        .content
        .into_iter()
        .find(|c| c.content_type == "text")
        .and_then(|c| c.text)
        .unwrap_or_default();

    Ok(text)
}

/// تحليل JSON من رد الـ LLM (متسامح مع markdown code blocks)
fn parse_shorts_json(raw: &str) -> Result<Vec<ShortSuggestion>, AppError> {
    // تنظيف: إزالة markdown code blocks إن وجدت
    let cleaned = raw
        .trim()
        .strip_prefix("```json")
        .or_else(|| raw.trim().strip_prefix("```"))
        .unwrap_or(raw)
        .trim()
        .trim_end_matches("```")
        .trim();

    // محاولة parse مباشرة
    match serde_json::from_str::<Vec<ShortSuggestion>>(cleaned) {
        Ok(result) => {
            // فلترة: تأكيد أن المدة ≤ 60 ثانية
            let filtered: Vec<ShortSuggestion> = result
                .into_iter()
                .filter(|s| {
                    let duration = s.end - s.start;
                    duration >= 5.0 && duration <= 60.0
                })
                .map(|mut s| {
                    // تنظيف العنوان
                    s.title = s.title.trim().to_string();
                    s
                })
                .collect();

            Ok(filtered)
        }
        Err(e) => {
            log::warn!("فشل parse JSON المباشر: {}. محاولة استخراج يدوي...", e);

            // محاولة استخراج يدوي: ابحث عن [ ... ]
            if let Some(start) = cleaned.find('[') {
                if let Some(end) = cleaned.rfind(']') {
                    if end > start {
                        let json_part = &cleaned[start..=end];
                        match serde_json::from_str::<Vec<ShortSuggestion>>(json_part) {
                            Ok(result) => return Ok(result),
                            Err(e2) => {
                                return Err(AppError {
                                    error_type: "ParseError".into(),
                                    message: "تعذّر تحليل JSON من الـ LLM".into(),
                                    details: Some(format!(
                                        "خطأ: {}\nالنص الخام:\n{}",
                                        e2, raw
                                    )),
                                });
                            }
                        }
                    }
                }
            }

            Err(AppError {
                error_type: "ParseError".into(),
                message: "تعذّر تحليل JSON من الـ LLM".into(),
                details: Some(format!("{}\n---\n{}", e, raw)),
            })
        }
    }
}

// ═══════════════════════════════════════════════════════════════
//  كشف الأخطاء غير المنطقية في التفريغ (عبر Gemini)
// ═══════════════════════════════════════════════════════════════

/// 🔍 كشف المواضع غير المنطقية في التفريغ التي قد تعني خطأً في التفريغ
///
/// يرسل التفريغ (نص + طوابع زمنية) إلى نموذج Gemini ويطلب منه تحديد
/// الجُمل أو العبارات التي تبدو غير مترابطة أو غير منطقية أو من المرجّح
/// أنها ناتجة عن خطأ في التعرّف الصوتي (ASR).
///
/// # المعاملات
/// - `transcript_json`: JSON يحتوي على [{word, start, end}, ...]
/// - `api_key`: مفتاح Gemini API
/// - `model`: اسم الموديل (افتراضي: gemini-2.5-flash)
/// - `language`: كود اللغة (للسياق فقط، افتراضي: "ar")
#[tauri::command]
pub async fn detect_transcript_issues(
    transcript_json: String,
    api_key: String,
    provider: Option<String>,
    model: Option<String>,
    language: Option<String>,
    system_prompt: Option<String>,
) -> Result<Vec<TranscriptIssue>, AppError> {
    let provider = provider.unwrap_or_else(|| "gemini".to_string());
    let model = model.unwrap_or_else(|| match provider.as_str() {
        "anthropic" => "claude-sonnet-4-20250514".to_string(),
        "openai" => "gpt-4o".to_string(),
        _ => "gemini-2.5-flash".to_string(),
    });
    let _language = language.unwrap_or_else(|| "ar".to_string());

    log::info!("🔍 كشف أخطاء التفريغ عبر {} (موديل: {})", provider, model);

    if api_key.is_empty() {
        return Err(AppError {
            error_type: "MissingApiKey".into(),
            message: "مفتاح الـ API مطلوب لكشف الأخطاء".into(),
            details: Some("أضف المفتاح من قسم الإعدادات".into()),
        });
    }

    // بناء جمل مع طوابع زمنية (نعيد استخدام منطق Shorts)
    let sentences = build_sentences_from_transcript(&transcript_json)?;
    if sentences.is_empty() {
        return Err(AppError {
            error_type: "EmptyTranscript".into(),
            message: "لا يوجد نص كافٍ للتحليل".into(),
            details: None,
        });
    }

    let system_prompt = match system_prompt {
        Some(p) if !p.trim().is_empty() => p,
        _ => build_issues_system_prompt(),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| AppError {
            error_type: "HttpClientError".into(),
            message: format!("خطأ في إنشاء عميل HTTP: {}", e),
            details: None,
        })?;

    // ─── التقطيع: نقسّم الجمل إلى دفعات ونعالجها بالتتابع ──────────
    // يبقي إخراج كل طلب صغيراً (لا اقتطاع) ويتجاوز حدود نافذة السياق.
    // الطوابع الزمنية مطلقة، فدمج النتائج مباشر.
    const CHUNK_SENTENCES: usize = 120;
    let total_chunks = sentences.len().div_ceil(CHUNK_SENTENCES);

    let mut all_issues: Vec<TranscriptIssue> = Vec::new();
    let mut last_error: Option<AppError> = None;
    let mut failed_chunks = 0usize;

    for (idx, chunk) in sentences.chunks(CHUNK_SENTENCES).enumerate() {
        log::info!(
            "🔍 كشف الأخطاء — الدفعة {}/{} ({} جملة)",
            idx + 1,
            total_chunks,
            chunk.len()
        );

        let mut transcript_for_llm = String::new();
        for s in chunk {
            transcript_for_llm.push_str(&format!("[{:.1}s - {:.1}s] {}\n", s.start, s.end, s.text));
        }

        let user_prompt = format!(
            "إليك تفريغ آلي (ASR) لفيديو بالعربية، كل سطر يحتوي على الفترة الزمنية ثم النص:\n\n\
            {}\n\n\
            حدّد المواضع التي يبدو فيها الكلام غير منطقي أو غير مترابط أو من المرجّح \
            أنه ناتج عن خطأ في التفريغ (كلمة غير مناسبة للسياق، جملة مبتورة، تحريف واضح). \
            لكل موضع أعطِ الفترة الزمنية المطابقة والسبب وتصحيحاً مقترحاً. \
            ردّ بصيغة JSON فقط بدون أي نص إضافي.",
            transcript_for_llm
        );

        let raw_response = match provider.as_str() {
            "anthropic" => call_anthropic(&client, &api_key, &model, &system_prompt, &user_prompt).await,
            "openai" => call_openai(&client, &api_key, &model, &system_prompt, &user_prompt).await,
            _ => call_gemini(&client, &api_key, &model, &system_prompt, &user_prompt).await,
        };

        let raw_response = match raw_response {
            Ok(r) => r,
            Err(e) => {
                // أخطاء المفتاح/الشبكة قاطعة — لا فائدة من متابعة بقية الدفعات
                if e.error_type == "ApiError" || e.error_type == "NetworkError" {
                    return Err(e);
                }
                log::warn!("⚠️ فشلت الدفعة {}/{}: {}", idx + 1, total_chunks, e.message);
                failed_chunks += 1;
                last_error = Some(e);
                continue;
            }
        };

        match parse_issues_json(&raw_response) {
            Ok(mut issues) => all_issues.append(&mut issues),
            Err(e) => {
                log::warn!("⚠️ تعذّر تحليل الدفعة {}/{}: {}", idx + 1, total_chunks, e.message);
                failed_chunks += 1;
                last_error = Some(e);
            }
        }
    }

    // إن فشلت كل الدفعات ولم نحصل على أي نتيجة، أعِد آخر خطأ
    if all_issues.is_empty() {
        if let Some(e) = last_error {
            return Err(e);
        }
    }

    // ترتيب زمني موحّد بعد الدمج
    all_issues.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));

    log::info!(
        "✅ كشف الأخطاء: {} موضع مشبوه ({} دفعة، {} فشلت)",
        all_issues.len(),
        total_chunks,
        failed_chunks
    );

    Ok(all_issues)
}

/// البرومبت الموجّه للنموذج لكشف الأخطاء غير المنطقية
fn build_issues_system_prompt() -> String {
    r#"أنت مدقّق لغوي خبير متخصص في مراجعة نصوص التفريغ الآلي (ASR) للمحتوى العربي.

مهمتك: قراءة التفريغ واكتشاف المواضع التي من المرجّح أنها تحتوي على خطأ في التفريغ، أي:
- كلمة لا تناسب السياق أو تكسر المعنى
- جملة غير مترابطة أو غير منطقية
- تحريف صوتي واضح (كلمة قريبة صوتياً من الصحيحة لكنها خاطئة)
- أسماء أو مصطلحات مشوّهة

## قواعد مهمة:
- لا تُبلّغ عن أخطاء إملائية بسيطة أو علامات ترقيم — ركّز على ما يشير لخطأ تفريغ حقيقي
- إذا كان النص سليماً ومنطقياً، أعد مصفوفة فارغة []
- استخدم الطوابع الزمنية المُعطاة كما هي (start/end بالثواني)
- رتّب النتائج حسب الخطورة (الأعلى أولاً)

## قيود صارمة على الإخراج:
- أعد فقط JSON صالح بدون أي نص قبله أو بعده
- لا تستخدم markdown code blocks

## صيغة الإخراج المطلوبة بالضبط:
[
  {
    "text": "النص المشبوه كما ورد",
    "start": 12.5,
    "end": 14.2,
    "reason": "سبب اعتباره خطأً محتملاً",
    "suggestion": "التصحيح المقترح أو تركه فارغاً",
    "severity": "high"
  }
]

قيمة severity يجب أن تكون واحدة من: "high" أو "medium" أو "low"."#
        .to_string()
}

/// تحليل JSON لقائمة الأخطاء من رد الـ LLM (متسامح مع markdown)
fn parse_issues_json(raw: &str) -> Result<Vec<TranscriptIssue>, AppError> {
    let cleaned = raw
        .trim()
        .strip_prefix("```json")
        .or_else(|| raw.trim().strip_prefix("```"))
        .unwrap_or(raw)
        .trim()
        .trim_end_matches("```")
        .trim();

    // 1) محاولة كمصفوفة [ ... ] (نستخرج ما بين أول [ وآخر ])
    if let (Some(start), Some(end)) = (cleaned.find('['), cleaned.rfind(']')) {
        if end > start {
            let array_candidate = &cleaned[start..=end];
            if let Ok(v) = serde_json::from_str::<Vec<TranscriptIssue>>(array_candidate) {
                return Ok(v);
            }
        }
    }

    // 2) محاولة كائن مُغلِّف: { "issues": [...] } أو { "results": [...] } ...
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(cleaned) {
        if let Some(obj) = val.as_object() {
            for key in ["issues", "results", "data", "items", "errors"] {
                if let Some(arr) = obj.get(key) {
                    if let Ok(v) = serde_json::from_value::<Vec<TranscriptIssue>>(arr.clone()) {
                        return Ok(v);
                    }
                }
            }
            // 3) كائن واحد يمثّل خطأً مفرداً
            if let Ok(single) = serde_json::from_value::<TranscriptIssue>(val.clone()) {
                return Ok(vec![single]);
            }
        }
    }

    // فشلت كل المحاولات — أعد الخطأ مع المحتوى الخام للتشخيص
    let parse_err = serde_json::from_str::<Vec<TranscriptIssue>>(cleaned)
        .err()
        .map(|e| e.to_string())
        .unwrap_or_else(|| "صيغة غير متوقعة".to_string());
    Err(AppError {
        error_type: "ParseError".into(),
        message: "تعذّر تحليل نتائج كشف الأخطاء من النموذج".into(),
        details: Some(format!("{}\n---\n{}", parse_err, raw)),
    })
}

// ═══════════════════════════════════════════════════════════════
//  المرحلة 4 — استخراج Short كملف منفصل
// ═══════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────
//  اقتراح عناوين الفقرات (plan.md §3.3 + §5.2)
// ───────────────────────────────────────────────────────────────

/// فقرة مُدخَلة لطلب اقتراح العناوين
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParagraphInput {
    pub start_token_id: String,
    pub end_token_id: String,
    pub text: String,
}

/// اقتراح عنوان: قبل هذا التوكن يظهر العنوان
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeadingSuggestion {
    pub before_token_id: String,
    pub heading: String,
}

/// يُنشئ عناوين للفقرات عبر نموذج لغوي (plan.md §3.3 / §5.2).
/// لا يُلمس أي توكِن — اقتراحات فقط، والتطبيق يتم بمراجعة صريحة في الواجهة.
#[tauri::command]
pub async fn generate_paragraph_headings(
    paragraphs: Vec<ParagraphInput>,
    api_key: String,
    provider: Option<String>,
    model: Option<String>,
    language: Option<String>,
) -> Result<Vec<HeadingSuggestion>, AppError> {
    let provider = provider.unwrap_or_else(|| "gemini".to_string());
    let model = model.unwrap_or_else(|| match provider.as_str() {
        "anthropic" => "claude-sonnet-4-20250514".to_string(),
        "openai" => "gpt-4o".to_string(),
        _ => "gemini-2.5-flash".to_string(),
    });
    let _language = language.unwrap_or_else(|| "ar".to_string());

    log::info!(
        "🪧 اقتراح عناوين الفقرات عبر {} (موديل: {})",
        provider,
        model
    );

    if api_key.is_empty() {
        return Err(AppError {
            error_type: "MissingApiKey".into(),
            message: "مفتاح الـ API مطلوب لاقتراح العناوين".into(),
            details: Some("أضف المفتاح من قسم الإعدادات".into()),
        });
    }

    if paragraphs.is_empty() {
        return Ok(Vec::new());
    }

    // بناء نص الفقرات بأرقامها (الـ LLM يردّ بأرقام، فنطابقها بأمان)
    let mut numbered = String::new();
    for (i, p) in paragraphs.iter().enumerate() {
        let snippet = p.text.chars().take(280).collect::<String>();
        numbered.push_str(&format!("[#{:03}] {}\n", i, snippet));
    }

    let system_prompt = "أنت محرّر متخصص في تقسيم المحاضرات والدروس العربية الطويلة إلى فصول بعناوين وصفية موجزة.\n\
        مهمتك: قراءة قائمة الفقرات (مرقّمة) واقتراح عنوان قصير (3-7 كلمات عربية) للفقرات التي تمثّل انتقالاً واضحاً في الموضوع.\n\
        أضف عنواناً فقط عند تغيّر الموضوع فعلاً — لا تُعنون كل فقرة.\n\
        أعد JSON صالحاً فقط بدون أي شرح أو markdown.";

    let user_prompt = format!(
        "إليك {} فقرة من محاضرة عربية، مرقّمة [#000]..[#{:03}]. \
        اقترح عنواناً قصيراً لكل فقرة تمثّل تغيّراً في الموضوع (ليس كلها).\n\n{}\
        \n\nأعد JSON بهذا الشكل بالضبط:\n\
        [{{\"index\": 5, \"heading\": \"شروط صحة الحديث\"}}]",
        paragraphs.len(),
        paragraphs.len().saturating_sub(1),
        numbered
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| AppError {
            error_type: "HttpClientError".into(),
            message: format!("خطأ في إنشاء عميل HTTP: {}", e),
            details: None,
        })?;

    let raw_response = match provider.as_str() {
        "anthropic" => call_anthropic(&client, &api_key, &model, system_prompt, &user_prompt).await,
        "openai" => call_openai(&client, &api_key, &model, system_prompt, &user_prompt).await,
        _ => call_gemini(&client, &api_key, &model, system_prompt, &user_prompt).await,
    }
    .map_err(|e| {
        log::warn!("⚠️ فشل اقتراح العناوين: {}", e.message);
        e
    })?;

    // تحليل مرن: نقبل إما [{index, heading}] أو [{beforeTokenId, heading}]
    let cleaned = strip_code_fences(&raw_response);
    let mut suggestions: Vec<HeadingSuggestion> = Vec::new();

    if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&cleaned) {
        for v in arr {
            let heading = v
                .get("heading")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if heading.is_empty() {
                continue;
            }
            if let Some(idx) = v.get("index").and_then(|x| x.as_u64()) {
                if (idx as usize) < paragraphs.len() {
                    suggestions.push(HeadingSuggestion {
                        before_token_id: paragraphs[idx as usize].start_token_id.clone(),
                        heading,
                    });
                }
            } else if let Some(tid) = v
                .get("beforeTokenId")
                .or_else(|| v.get("before_token_id"))
                .and_then(|x| x.as_str())
            {
                suggestions.push(HeadingSuggestion {
                    before_token_id: tid.to_string(),
                    heading,
                });
            }
        }
    }

    log::info!("🪧 {} عنوان مقترح", suggestions.len());
    Ok(suggestions)
}

/// يجرّد أسوار الكود (```json ... ```) إن وُجدت — مرن مع مختلف النماذج
fn strip_code_fences(s: &str) -> String {
    let t = s.trim();
    if let Some(start) = t.find("```") {
        let after = &t[start + 3..];
        let body = if let Some(stripped) = after.strip_prefix("json") {
            stripped
        } else if let Some(stripped) = after.strip_prefix("JSON") {
            stripped
        } else {
            after
        };
        if let Some(end) = body.rfind("```") {
            return body[..end].trim().to_string();
        }
    }
    t.to_string()
}

/// ✂️ استخراج مقطع قصير من الفيديو وحفظه كملف منفصل
///
/// يستخدم FFmpeg مع -ss (seek) و -to للقص، ومرشّح `-vf` حسب القالب
/// المختار (plan.md §4.2). يدعم ترجمة محروقة داخل الفيديو (plan.md §4.3)
/// عبر فلتر `subtitles` (libass). يولّد ملف SRT مقصوصًا على النطاق
/// عند توفّر `srt_content` (plan.md §4.1).
///
/// # المعاملات
/// - `video_path`: مسار الفيديو الأصلي
/// - `start`: ثانية البدء
/// - `end`: ثانية الانتهاء
/// - `title`: عنوان المقطع (يُستخدم لاسم الملف)
/// - `output_dir`: مجلد الإخراج (None = مجلد Shorts داخل الكاش)
/// - `template`: "original" | "blur-9x16" | "crop-9x16"
/// - `burn_subtitles`: ترجمة محروقة داخل الفيديو (libass)
/// - `srt_content`: نص SRT مقصوص مسبقًا ومُعاد توقيته للصفر
#[tauri::command]
pub async fn extract_short(
    app: tauri::AppHandle,
    video_path: String,
    start: f64,
    end: f64,
    title: String,
    output_dir: Option<String>,
    template: Option<String>,
    burn_subtitles: Option<bool>,
    srt_content: Option<String>,
) -> Result<ShortExtractResult, AppError> {
    let ffmpeg = check_ffmpeg()?;
    let template = template.unwrap_or_else(|| "original".to_string());
    let burn = burn_subtitles.unwrap_or(false);

    if !Path::new(&video_path).exists() {
        return Err(AppError {
            error_type: "FileNotFound".into(),
            message: "ملف الفيديو غير موجود".into(),
            details: Some(video_path),
        });
    }

    let duration = end - start;
    if duration < 1.0 {
        return Err(AppError {
            error_type: "InvalidRange".into(),
            message: "المدة قصيرة جداً (أقل من ثانية)".into(),
            details: Some(format!("البدء: {}، النهاية: {}", start, end)),
        });
    }

    log::info!(
        "✂️ استخراج Short: '{}' [{:.1}s - {:.1}s] ({:.1}s)",
        title,
        start,
        end,
        duration
    );

    // ─── تنظيف العنوان لاسم ملف آمن ─────────────────────────────
    let safe_title: String = title
        .chars()
        .filter(|c| {
            c.is_alphanumeric() || *c == '-' || *c == '_' || *c == ' '
        })
        .collect::<String>()
        .trim()
        .replace(' ', "_");

    // ─── مجلد الإخراج: يختاره المستخدم، وإلا مجلد Shorts في الكاش ──
    let shorts_dir: PathBuf = match output_dir.as_deref() {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => get_temp_dir(&app)?.join("shorts"),
    };
    std::fs::create_dir_all(&shorts_dir).map_err(|e| AppError {
        error_type: "DirError".into(),
        message: format!("تعذّر إنشاء مجلد Shorts: {}", e),
        details: None,
    })?;

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let output_name = format!("{}_{}.mp4", safe_title, timestamp);
    let output_path = shorts_dir.join(&output_name);
    let output_str = output_path.to_string_lossy().to_string();

    // ─── كتابة SRT المقصوص إلى جانب الفيديو (plan.md §4.1) ─────────
    let mut srt_path: Option<String> = None;
    if let Some(srt) = srt_content.as_ref() {
        if !srt.trim().is_empty() {
            let srt_file = shorts_dir.join(format!("{}_{}.srt", safe_title, timestamp));
            std::fs::write(&srt_file, srt).map_err(|e| AppError {
                error_type: "SrtWriteError".into(),
                message: format!("تعذّر كتابة ملف SRT: {}", e),
                details: None,
            })?;
            srt_path = Some(srt_file.to_string_lossy().to_string());
            log::info!("📝 SRT مقصوص: {}", srt_path.as_ref().unwrap());
        }
    }

    // ─── اختيار فلتر -vf حسب القالب (plan.md §4.2) ─────────────────
    let vf = build_video_filter(&template, srt_path.as_deref(), burn);
    let has_filter = !vf.is_empty();

    // ─── أمر FFmpeg: -ss قبل -i للقص السريع (keyframe seek) ──────
    // ثم -to للحد النهائي. نعيد ترميز بجودة عالية.
    let mut cmd = Command::new(&ffmpeg);
    cmd.args([
        "-ss", &format!("{:.3}", start),
        "-i", &video_path,
        "-to", &format!("{:.3}", duration),
    ]);
    if has_filter {
        cmd.args(["-vf", &vf]);
    }
    cmd.args([
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "21",
        "-c:a", "aac",
        "-b:a", "192k",
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart",
        "-y",
        &output_str,
    ]);

    let ffmpeg_output = cmd.output().map_err(|e| AppError {
        error_type: "FFmpegExecutionError".into(),
        message: format!("فشل تشغيل FFmpeg: {}", e),
        details: None,
    })?;

    if !ffmpeg_output.status.success() {
        let stderr = String::from_utf8_lossy(&ffmpeg_output.stderr);
        log::error!("FFmpeg short extract stderr: {}", stderr);

        return Err(AppError {
            error_type: "ExtractError".into(),
            message: "فشل استخراج المقطع القصير".into(),
            details: Some(stderr.to_string()),
        });
    }

    log::info!("✅ تم استخراج Short: {}", output_str);

    let message = match srt_path.as_ref() {
        Some(_) => format!("تم استخراج '{}' مع SRT مقصوص ({:.1}s)", title, duration),
        None => format!("تم استخراج '{}' بنجاح ({:.1}s)", title, duration),
    };

    Ok(ShortExtractResult {
        success: true,
        output_path: output_str,
        title,
        duration,
        message,
        srt_path,
    })
}

/// يبني سلسلة فلتر FFmpeg حسب القالب + الترجمة المحروقة (plan.md §4.2/§4.3)
fn build_video_filter(
    template: &str,
    srt_path: Option<&str>,
    burn_subtitles: bool,
) -> String {
    let mut chain: Vec<String> = Vec::new();
    match template {
        "blur-9x16" => {
            // خلفية ضبابية 1080×1920 مع الفيديو الأصلي في الوسط
            chain.push("split[bg][fg]".to_string());
            chain.push(
                "[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=40:10[bg2]"
                    .to_string(),
            );
            chain.push("[fg]scale=1080:-2[fg2]".to_string());
            chain.push("[bg2][fg2]overlay=(W-w)/2:(H-h)/2".to_string());
        }
        "crop-9x16" => {
            chain.push("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920".to_string());
        }
        "original" | _ => {
            // لا فلتر — يبقى الفيديو كما هو
        }
    }
    if burn_subtitles {
        if let Some(p) = srt_path {
            // libass: force_style لتوحيد الخط والموقع (أسفل الوسط)
            let esc = p.replace('\\', "\\\\").replace(':', "\\:");
            let style = "FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,BorderStyle=1,Alignment=2,MarginV=40";
            chain.push(format!("subtitles={}:si=0:force_style={}", esc, style));
        }
    }
    chain.join(",")
}

// ═══════════════════════════════════════════════════════════════
//  فتح مجلد المخرجات (Reveal in Folder)
// ═══════════════════════════════════════════════════════════════

/// تصدير مستند DOCX (plan.md §2.6 + ملحق أ).
/// يفتح حوار حفظ ثم يكتب البايتات المُمرّرة من الواجهة.
/// @returns مسار الحفظ إن اختار المستخدم موقعًا، `None` عند الإلغاء.
#[tauri::command]
pub async fn export_docx(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    default_name: String,
) -> Result<Option<String>, AppError> {
    use tauri_plugin_dialog::DialogExt;

    let default = if default_name.trim().is_empty() {
        "document.docx".to_string()
    } else {
        default_name
    };

    let file_path = app
        .dialog()
        .file()
        .add_filter("مستند Word", &["docx"])
        .set_file_name(&default)
        .blocking_save_file();

    let path = match file_path {
        Some(p) => p,
        None => return Ok(None),
    };
    let path_buf = path.into_path().map_err(|e| AppError {
        error_type: "InvalidPath".into(),
        message: format!("مسار غير صالح: {e}"),
        details: None,
    })?;

    std::fs::write(&path_buf, &bytes).map_err(|e| AppError {
        error_type: "WriteFailed".into(),
        message: format!("فشل الكتابة: {e}"),
        details: Some(path_buf.to_string_lossy().to_string()),
    })?;

    log::info!("تم حفظ DOCX: {}", path_buf.display());
    Ok(Some(path_buf.to_string_lossy().to_string()))
}

/// 📦 تصدير مشروع كامل إلى ملف JSON عبر حوار حفظ (plan.md §5.4).
/// @returns مسار الحفظ أو None عند الإلغاء.
#[tauri::command]
pub async fn export_project_file(
    app: tauri::AppHandle,
    json: String,
    default_name: String,
) -> Result<Option<String>, AppError> {
    use tauri_plugin_dialog::DialogExt;
    let default = if default_name.trim().is_empty() {
        "project.json".to_string()
    } else {
        default_name
    };
    let file_path = app
        .dialog()
        .file()
        .add_filter("مشروع Aravid", &["json"])
        .set_file_name(&default)
        .blocking_save_file();
    let path = match file_path {
        Some(p) => p,
        None => return Ok(None),
    };
    let path_buf = path.into_path().map_err(|e| AppError {
        error_type: "InvalidPath".into(),
        message: format!("مسار غير صالح: {e}"),
        details: None,
    })?;
    std::fs::write(&path_buf, json.as_bytes()).map_err(|e| AppError {
        error_type: "WriteFailed".into(),
        message: format!("فشل الكتابة: {e}"),
        details: Some(path_buf.to_string_lossy().to_string()),
    })?;
    log::info!("📦 تم تصدير المشروع: {}", path_buf.display());
    Ok(Some(path_buf.to_string_lossy().to_string()))
}

/// 📂 استيراد مشروع من ملف JSON عبر حوار فتح (plan.md §5.4).
/// @returns محتوى JSON إن اختار المستخدم ملفاً صالحاً.
#[tauri::command]
pub async fn import_project_file(app: tauri::AppHandle) -> Result<Option<String>, AppError> {
    use tauri_plugin_dialog::DialogExt;
    let file_path = app
        .dialog()
        .file()
        .add_filter("مشروع Aravid", &["json"])
        .blocking_pick_file();
    let path = match file_path {
        Some(p) => p,
        None => return Ok(None),
    };
    let path_buf = path.into_path().map_err(|e| AppError {
        error_type: "InvalidPath".into(),
        message: format!("مسار غير صالح: {e}"),
        details: None,
    })?;
    let content = std::fs::read_to_string(&path_buf).map_err(|e| AppError {
        error_type: "ReadFailed".into(),
        message: format!("فشل قراءة الملف: {e}"),
        details: Some(path_buf.to_string_lossy().to_string()),
    })?;
    log::info!("📂 تم استيراد المشروع: {}", path_buf.display());
    Ok(Some(content))
}

/// فتح مستكشف الملفات على مجلد المخرجات مع تحديد الملف إن أمكن.
///
/// يدعم Windows (explorer /select) و macOS (open -R) و Linux (xdg-open للمجلد الأب).
#[tauri::command]
pub async fn reveal_in_folder(path: String) -> Result<(), AppError> {
    log::info!("فتح مجلد المخرجات: {}", path);

    let target = Path::new(&path);
    if !target.exists() {
        return Err(AppError {
            error_type: "FileNotFound".into(),
            message: "المسار غير موجود".into(),
            details: Some(path.clone()),
        });
    }

    #[cfg(target_os = "windows")]
    let result = Command::new("explorer")
        .arg("/select,")
        .arg(&path)
        .spawn();

    #[cfg(target_os = "macos")]
    let result = Command::new("open").args(["-R", &path]).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let result = {
        // على لينكس نفتح المجلد الحاوي (لا يوجد تحديد للملف بشكل موحّد)
        let dir = if target.is_dir() {
            target.to_path_buf()
        } else {
            target
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| target.to_path_buf())
        };
        Command::new("xdg-open").arg(dir).spawn()
    };

    // ملاحظة: explorer.exe يُرجع أحياناً رمز خروج غير صفري رغم نجاح الفتح،
    // لذا نتحقّق فقط من نجاح بدء العملية (spawn) لا من رمز الخروج.
    result.map_err(|e| AppError {
        error_type: "RevealError".into(),
        message: format!("تعذّر فتح مجلد المخرجات: {}", e),
        details: Some(path),
    })?;

    Ok(())
}

// ═══════════════════════════════════════════════════════════════
//  المرحلة 5 — حفظ المشاريع واستعادتها
//  كل مشروع ملف JSON واحد: { meta: {...}, data: {...} }
//  يُخزَّن في مجلد بيانات التطبيق (وليس الكاش — لا يُمسح تلقائياً)
// ═══════════════════════════════════════════════════════════════

/// تنظيف معرّف المشروع — حماية من اجتياز المسارات (Path Traversal)
fn sanitize_project_id(id: &str) -> Result<String, AppError> {
    let clean: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();

    if clean.is_empty() || clean.len() > 100 {
        return Err(AppError {
            error_type: "InvalidProjectId".into(),
            message: "معرّف المشروع غير صالح".into(),
            details: Some(id.to_string()),
        });
    }
    Ok(clean)
}

/// 💾 حفظ مشروع (إنشاء أو تحديث) — يستقبل الحمولة كاملة كـ JSON من الواجهة
///
/// قبل أول كتابة بالنموذج الجديد (schemaVersion 2) نُنشئ نسخة احتياطية
/// `.json.bak` من ملف v1 الأصلي، حفاظاً على بيانات المستخدم عند الترحيل
/// (راجع plan.md §2.4). تُنشأ مرة واحدة فقط عند الترقية من v1 إلى v2.
#[tauri::command]
pub async fn save_project(
    app: tauri::AppHandle,
    id: String,
    project_json: String,
) -> Result<(), AppError> {
    let id = sanitize_project_id(&id)?;
    let dir = get_projects_dir(&app)?;
    let path = dir.join(format!("{}.json", id));
    let bak_path = dir.join(format!("{}.json.bak", id));

    // نسخة احتياطية قبل الترقية من v1 إلى v2 (مرّة واحدة)
    if path.exists() && !bak_path.exists() {
        let needs_backup = std::fs::read_to_string(&path)
            .ok()
            .map(|existing| {
                parse_schema_version(&existing) < 2 && parse_schema_version(&project_json) >= 2
            })
            .unwrap_or(false);

        if needs_backup {
            match std::fs::copy(&path, &bak_path) {
                Ok(_) => {
                    log::info!("🗂️ أُنشئت نسخة احتياطية قبل الترحيل: {}", bak_path.display());
                }
                Err(e) => {
                    log::warn!("تعذّر إنشاء النسخة الاحتياطية: {}", e);
                }
            }
        }
    }

    std::fs::write(&path, project_json).map_err(|e| AppError {
        error_type: "ProjectSaveError".into(),
        message: format!("تعذّر حفظ المشروع: {}", e),
        details: Some(path.to_string_lossy().to_string()),
    })?;

    log::info!("💾 حُفظ المشروع: {}", path.display());
    Ok(())
}

/// قراءة schemaVersion من JSON — المفقود يُفسَّر كـ v1 (1).
/// المظروف الحديث يحمل الحقل على المستوى الأعلى.
fn parse_schema_version(json: &str) -> i64 {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v.get("schemaVersion").and_then(|s| s.as_i64()))
        .unwrap_or(1)
}

/// 📋 قائمة المشاريع المحفوظة — الأحدث أولاً
#[tauri::command]
pub async fn list_projects(app: tauri::AppHandle) -> Result<Vec<ProjectMeta>, AppError> {
    let dir = get_projects_dir(&app)?;

    let entries = std::fs::read_dir(&dir).map_err(|e| AppError {
        error_type: "ProjectListError".into(),
        message: format!("تعذّر قراءة مجلد المشاريع: {}", e),
        details: Some(dir.to_string_lossy().to_string()),
    })?;

    let mut projects: Vec<ProjectMeta> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // ملف تالف أو بصيغة قديمة غير مفهومة → يُتخطى بدل إفشال القائمة كلها
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        let Some(meta_val) = value.get("meta") else {
            continue;
        };
        let Ok(mut meta) = serde_json::from_value::<ProjectMeta>(meta_val.clone()) else {
            continue;
        };
        meta.video_exists = Path::new(&meta.video_path).exists();
        projects.push(meta);
    }

    // الأحدث تعديلاً أولاً (ISO 8601 يُرتَّب نصياً بشكل صحيح)
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    Ok(projects)
}

/// 📂 تحميل مشروع كاملاً — يُعيد JSON الحمولة كما حُفظت
#[tauri::command]
pub async fn load_project(app: tauri::AppHandle, id: String) -> Result<String, AppError> {
    let id = sanitize_project_id(&id)?;
    let path = get_projects_dir(&app)?.join(format!("{}.json", id));

    std::fs::read_to_string(&path).map_err(|e| AppError {
        error_type: "ProjectNotFound".into(),
        message: "تعذّر فتح المشروع — ربما حُذف ملفه".into(),
        details: Some(format!("{}: {}", path.display(), e)),
    })
}

/// 🗑 حذف مشروع محفوظ
#[tauri::command]
pub async fn delete_project(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
    let id = sanitize_project_id(&id)?;
    let path = get_projects_dir(&app)?.join(format!("{}.json", id));

    std::fs::remove_file(&path).map_err(|e| AppError {
        error_type: "ProjectDeleteError".into(),
        message: format!("تعذّر حذف المشروع: {}", e),
        details: Some(path.to_string_lossy().to_string()),
    })?;

    log::info!("🗑 حُذف المشروع: {}", path.display());
    Ok(())
}
