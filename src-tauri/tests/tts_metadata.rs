#[test]
fn tts_metadata() {
    let model_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../models/Kokoro-82M/onnx/model.onnx");
    if !model_path.exists() {
        eprintln!("Model not found: {}", model_path.display());
        return;
    }

    let session = ort::session::Session::builder().unwrap()
        .commit_from_file(&model_path).unwrap();

    println!("=== Model: {} ===", model_path.file_name().unwrap().to_string_lossy());
    println!("\nInputs:");
    for inp in session.inputs() {
        println!("  name: {}", inp.name());
    }
    println!("\nOutputs:");
    for out in session.outputs() {
        println!("  name: {}", out.name());
    }
}
