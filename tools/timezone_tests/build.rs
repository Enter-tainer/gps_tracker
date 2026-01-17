use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let data_dir = manifest_dir.join("..").join("..").join("firmware").join("data");
    if !data_dir.is_dir() {
        panic!("firmware data dir not found: {}", data_dir.display());
    }
    println!("cargo:rustc-env=TZ_DATA_DIR={}", data_dir.display());

    for name in [
        "tz_row_index.bin",
        "tz_rle.bin",
        "tz_transition_index.bin",
        "tz_transitions.bin",
    ] {
        println!(
            "cargo:rerun-if-changed={}",
            data_dir.join(name).display()
        );
    }
}
