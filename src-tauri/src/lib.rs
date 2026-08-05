// ═══════════════════════════════════════════════════════════════
//  المفرِّغ — كود Rust الخلفي (Tauri Backend)
//  المرحلة 1: اختيار الفيديو + استخراج الصوت عبر FFmpeg
// ═══════════════════════════════════════════════════════════════

mod commands;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;

// ───────────────────────────────────────────────────────────────
//  هياكل البيانات (Data Structures)
// ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInfo {
    pub path: String,
    pub file_name: String,
    pub file_size_mb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioExtractionResult {
    pub success: bool,
    pub output_path: String,
    pub message: String,
    pub output_size_mb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppError {
    pub error_type: String,
    pub message: String,
    pub details: Option<String>,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.error_type, self.message)
    }
}

// ───────────────────────────────────────────────────────────────
//  هياكل المرحلة 2: كشف السكتات + التفريغ الصوتي
// ───────────────────────────────────────────────────────────────

/// فترة سكتة (صمت) مكتشفة
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SilenceSegment {
    /// بداية السكتة بالثواني
    pub start: f64,
    /// نهاية السكتة بالثواني
    pub end: f64,
    /// مدة السكتة بالثواني
    pub duration: f64,
}

/// نتيجة كشف السكتات
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SilenceDetectionResult {
    pub segments: Vec<SilenceSegment>,
    pub total_silence_duration: f64,
    pub total_audio_duration: f64,
    pub silence_count: usize,
    /// نسبة الصمت من إجمالي الملف (0.0 - 1.0)
    pub silence_ratio: f64,
}

/// كلمة واحدة مع طابع زمني
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WordTimestamp {
    pub word: String,
    pub start: f64,
    pub end: f64,
    /// درجة ثقة النموذج بالكلمة (0.0 - 1.0)
    /// تتوفّر من Speechmatics فقط — Whisper (groq/openai) لا يُرجعها ⇒ None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
}

/// نتيجة التفريغ الصوتي
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionResult {
    pub words: Vec<WordTimestamp>,
    /// النص الكامل المُفرّغ
    pub full_text: String,
    pub language: String,
    pub duration: f64,
}

// ───────────────────────────────────────────────────────────────
//  هياكل المرحلة 4: التصدير + Shorts
// ───────────────────────────────────────────────────────────────

/// فترة زمنية مستبعدة (محذوفة) من الفيديو
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeRange {
    pub start: f64,
    pub end: f64,
}

/// نتيجة التصدير النهائي
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportResult {
    pub success: bool,
    pub output_path: String,
    pub output_size_mb: f64,
    pub original_duration: f64,
    pub final_duration: f64,
    pub message: String,
}

/// اقتراح مقطع قصير (Short) من الـ LLM
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShortSuggestion {
    pub title: String,
    pub start: f64,
    pub end: f64,
    pub reason: String,
}

/// نتيجة استخراج Short
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShortExtractResult {
    pub success: bool,
    pub output_path: String,
    pub title: String,
    pub duration: f64,
    pub message: String,
    /// مسار ملف SRT المقصوص (None إن لم يُولَّد) — plan.md §4.1
    pub srt_path: Option<String>,
}

/// موضع مشبوه في التفريغ (خطأ محتمل / كلام غير منطقي)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptIssue {
    /// النص المشبوه كما ورد في التفريغ
    pub text: String,
    /// بداية الموضع بالثواني
    pub start: f64,
    /// نهاية الموضع بالثواني
    pub end: f64,
    /// سبب اعتباره خطأً محتملاً
    pub reason: String,
    /// تصحيح مقترح (إن وُجد)
    #[serde(default)]
    pub suggestion: String,
    /// درجة الخطورة: "high" | "medium" | "low"
    #[serde(default)]
    pub severity: String,
}

// ───────────────────────────────────────────────────────────────
//  هياكل المرحلة 5: حفظ المشاريع
// ───────────────────────────────────────────────────────────────

/// بيانات وصفية لمشروع محفوظ (تُعرض في قائمة المشاريع)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    pub video_path: String,
    /// يُعاد حسابها عند العرض — هل ملف الفيديو ما زال موجوداً؟
    #[serde(default)]
    pub video_exists: bool,
    pub updated_at: String,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub word_count: usize,
    #[serde(default)]
    pub deleted_count: usize,
}

/// حالة مشتركة لعلم إلغاء التفريغ (يُضبط عبر cancel_transcription)
#[derive(Default)]
pub struct TranscriptionCancel(
    pub std::sync::Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
);

// ───────────────────────────────────────────────────────────────
//  دوال مساعدة (Helper Functions)
// ───────────────────────────────────────────────────────────────

/// مجلد المشاريع المحفوظة داخل بيانات التطبيق (يُنشأ إن لم يوجد)
pub fn get_projects_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let base = app.path().app_data_dir().map_err(|e| AppError {
        error_type: "DataDirError".into(),
        message: format!("تعذّر الوصول لمجلد بيانات التطبيق: {}", e),
        details: None,
    })?;

    let dir = base.join("projects");

    std::fs::create_dir_all(&dir).map_err(|e| AppError {
        error_type: "DataDirCreateError".into(),
        message: format!("تعذّر إنشاء مجلد المشاريع: {}", e),
        details: Some(dir.to_string_lossy().to_string()),
    })?;

    Ok(dir)
}

pub fn check_ffmpeg() -> Result<String, AppError> {
    log::info!("البحث عن FFmpeg على النظام...");
    let ffmpeg_path = which_ffmpeg()?;

    let output = std::process::Command::new(&ffmpeg_path)
        .args(["-version"])
        .output()
        .map_err(|e| AppError {
            error_type: "FFmpegExecutionError".into(),
            message: format!("تعذّر تشغيل FFmpeg: {}", e),
            details: Some(format!("المسار: {}", ffmpeg_path)),
        })?;

    if !output.status.success() {
        return Err(AppError {
            error_type: "FFmpegNotWorking".into(),
            message: "FFmpeg موجود لكنه لا يعمل بشكل صحيح".into(),
            details: Some(String::from_utf8_lossy(&output.stderr).to_string()),
        });
    }

    let version_line = String::from_utf8_lossy(&output.stdout);
    let first_line = version_line.lines().next().unwrap_or("FFmpeg");
    log::info!("تم العثور على: {}", first_line);

    Ok(ffmpeg_path)
}

/// اسم ثنائي FFmpeg حسب المنصّة.
///
/// Tauri يجرّد لاحقة الـ target triple عند التحزيم، فالـ sidecar المسمّى
/// `binaries/ffmpeg-x86_64-pc-windows-msvc.exe` يُثبَّت باسم `ffmpeg.exe`
/// بجانب الثنائي الرئيسي (وداخل `Contents/MacOS/` في حزمة macOS).
const FFMPEG_BIN: &str = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };

fn which_ffmpeg() -> Result<String, AppError> {
    // 1) الـ sidecar المُضمَّن مع التطبيق — له الأولوية دائماً على نسخة النظام،
    //    لأنه النسخة الوحيدة التي اختُبرت مع هذا الإصدار (plan.md §5.5).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in &[
                dir.join(FFMPEG_BIN),
                dir.join("binaries").join(FFMPEG_BIN),
                dir.join("resources").join(FFMPEG_BIN),
            ] {
                if candidate.is_file() {
                    log::info!("استُخدم FFmpeg المُضمَّن: {}", candidate.display());
                    return Ok(candidate.to_string_lossy().to_string());
                }
            }
        }
    }
    // 2) مسار النظام (PATH) — احتياطي لبيئة التطوير ولمن يفضّل نسخته

    if let Ok(path) = which::which("ffmpeg") {
        return Ok(path.to_string_lossy().to_string());
    }

    let linux_paths = [
        "/usr/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/snap/bin/ffmpeg",
    ];

    for path in &linux_paths {
        if Path::new(path).exists() {
            return Ok(path.to_string());
        }
    }

    Err(AppError {
        error_type: "FFmpegNotFound".into(),
        message: "تعذّر العثور على FFmpeg — ثبّته أو ضع ثنائيّته بجانب التطبيق".into(),
        details: Some(
            "ابحث عن ffmpeg.exe (ويندوز) أو ffmpeg (لينكس/ماك) في نفس مجلد التطبيق، أو ثبّته عبر مدير الحزم.".into(),
        ),
    })
}

pub fn get_temp_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let app_temp = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError {
            error_type: "TempDirError".into(),
            message: format!("تعذّر الوصول لمجلد الكاش: {}", e),
            details: None,
        })?;

    let temp_dir = app_temp.join("audio_extracts");

    std::fs::create_dir_all(&temp_dir).map_err(|e| AppError {
        error_type: "TempDirCreateError".into(),
        message: format!("تعذّر إنشاء المجلد المؤقت: {}", e),
        details: Some(temp_dir.to_string_lossy().to_string()),
    })?;

    Ok(temp_dir)
}

pub fn get_file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "audio".to_string())
}

pub fn is_supported_video(path: &str) -> bool {
    let supported = [
        ".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv", ".webm", ".m4v",
        ".mpg", ".mpeg", ".ts", ".3gp",
    ];
    let lower = path.to_lowercase();
    supported.iter().any(|ext| lower.ends_with(ext))
}

/// هل المسار صوت أو فيديو مدعوم؟ (لمسار النصّ — plan.md §3.1)
pub fn is_supported_media(path: &str) -> bool {
    let video = [
        ".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv", ".webm", ".m4v",
        ".mpg", ".mpeg", ".ts", ".3gp",
    ];
    let audio = [
        ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".wma", ".opus", ".oga",
    ];
    let lower = path.to_lowercase();
    video.iter().chain(audio.iter()).any(|ext| lower.ends_with(ext))
}

pub fn file_size_mb(path: &str) -> Result<f64, AppError> {
    let metadata = std::fs::metadata(path).map_err(|e| AppError {
        error_type: "FileAccessError".into(),
        message: format!("تعذّر قراءة الملف: {}", e),
        details: Some(path.to_string()),
    })?;
    Ok(metadata.len() as f64 / (1024.0 * 1024.0))
}

pub fn generate_output_name(input_path: &str) -> String {
    let stem = get_file_stem(input_path);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{}_{}.mp3", stem, timestamp)
}

// ───────────────────────────────────────────────────────────────
//  نقطة الدخول (Entry Point)
// ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(TranscriptionCancel::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            log::info!("╔═══════════════════════════════════════════╗");
            log::info!("║   المفرِّغ — بدء التشغيل                   ║");
            log::info!("╚═══════════════════════════════════════════╝");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::pick_video_file,
            commands::extract_audio,
            commands::ffmpeg_status,
            commands::detect_silence,
            commands::transcribe_audio,
            commands::export_video,
            commands::generate_shorts,
            commands::extract_short,
            commands::detect_transcript_issues,
            commands::reveal_in_folder,
            commands::save_project,
            commands::list_projects,
            commands::load_project,
            commands::delete_project,
            commands::cancel_transcription,
            commands::pick_output_folder,
            commands::pick_media_file,
            commands::export_docx,
            commands::generate_paragraph_headings,
            commands::export_project_file,
            commands::import_project_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
