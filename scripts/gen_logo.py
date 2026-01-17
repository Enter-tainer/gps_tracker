#!/usr/bin/env python3
"""
Generate Rust bitmap data from Ferris logo image for SSD1306 OLED display.

Usage:
    uv run --with pillow python scripts/gen_logo.py

This script:
1. Loads the Ferris image (image.png)
2. Resizes it to fit the OLED display (max 64px wide)
3. Converts to 1-bit monochrome bitmap
4. Outputs Rust code for the bitmap array
"""

from PIL import Image
import sys
from pathlib import Path


def image_to_mono_bitmap(img: Image.Image, bg_threshold: int = 250) -> list[list[int]]:
    """Convert image to monochrome bitmap.
    
    Detects non-white pixels as "on" (Ferris is orange on white background).
    """
    
    # Convert to RGB if not already
    if img.mode != 'RGB':
        img = img.convert('RGB')
    
    width, height = img.size
    bitmap = []
    
    for y in range(height):
        row = []
        for x in range(width):
            r, g, b = img.getpixel((x, y))
            # White background detection: if all channels are near 255, it's background
            is_background = (r > bg_threshold and g > bg_threshold and b > bg_threshold)
            pixel_on = not is_background
            row.append(1 if pixel_on else 0)
        bitmap.append(row)
    
    return bitmap


def bitmap_to_bytes(bitmap: list[list[int]]) -> tuple[bytes, int, int]:
    """Convert 2D bitmap to bytes array (MSB first, row-major)."""
    
    height = len(bitmap)
    width = len(bitmap[0]) if height > 0 else 0
    
    # Pad width to multiple of 8
    padded_width = ((width + 7) // 8) * 8
    
    data = []
    for row in bitmap:
        # Pad row to multiple of 8
        padded_row = row + [0] * (padded_width - len(row))
        
        # Convert to bytes (MSB first)
        for byte_idx in range(padded_width // 8):
            byte_val = 0
            for bit_idx in range(8):
                if padded_row[byte_idx * 8 + bit_idx]:
                    byte_val |= (0x80 >> bit_idx)
            data.append(byte_val)
    
    return bytes(data), padded_width, height


def generate_rust_code(data: bytes, width: int, height: int, name: str = "FERRIS_LOGO") -> str:
    """Generate Rust const array code."""
    
    lines = [
        f"// {name} bitmap: {width}x{height} pixels, 1-bit per pixel (MSB first)",
        f"// Each row is {width // 8} bytes ({width} bits), {height} rows total = {len(data)} bytes",
        f"const {name}_WIDTH: u32 = {width};",
        f"const {name}_HEIGHT: u32 = {height};",
        f"const {name}: [u8; {len(data)}] = [",
    ]
    
    bytes_per_row = width // 8
    for row_idx in range(height):
        row_start = row_idx * bytes_per_row
        row_end = row_start + bytes_per_row
        row_bytes = data[row_start:row_end]
        hex_str = ", ".join(f"0x{b:02X}" for b in row_bytes)
        lines.append(f"    {hex_str}, // Row {row_idx}")
    
    lines.append("];")
    
    return "\n".join(lines)


def print_ascii_preview(bitmap: list[list[int]]):
    """Print ASCII art preview of the bitmap."""
    print("\nASCII Preview:")
    print("-" * (len(bitmap[0]) + 2))
    for row in bitmap:
        line = "|" + "".join("█" if p else " " for p in row) + "|"
        print(line)
    print("-" * (len(bitmap[0]) + 2))


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Generate Rust bitmap from image")
    parser.add_argument("--width", type=int, default=64, help="Target width (default: 64)")
    parser.add_argument("--height", type=int, default=None, help="Target height (default: proportional)")
    parser.add_argument("--max-height", type=int, default=60, help="Maximum height (default: 60)")
    parser.add_argument("--name", type=str, default="FERRIS_LOGO", help="Const name prefix (default: FERRIS_LOGO)")
    parser.add_argument("--invert", action="store_true", help="Invert colors (for black icons on white bg)")
    parser.add_argument("image", nargs="?", default="image.png", help="Input image path")
    args = parser.parse_args()

    # Find project root
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    
    # Load image
    image_path = Path(args.image)
    if not image_path.is_absolute():
        image_path = project_root / image_path
    if not image_path.exists():
        print(f"Error: {image_path} not found")
        sys.exit(1)
    
    print(f"Loading: {image_path}")
    img = Image.open(image_path)
    print(f"Original size: {img.size}, mode: {img.mode}")
    
    # Target dimensions
    target_width = args.width
    aspect_ratio = img.height / img.width
    
    if args.height:
        target_height = args.height
    else:
        target_height = int(target_width * aspect_ratio)
    
    # Make sure it fits in max height
    if target_height > args.max_height:
        target_height = args.max_height
        target_width = int(target_height / aspect_ratio)
    
    # Make width multiple of 8 for easier byte alignment
    target_width = ((target_width + 7) // 8) * 8
    
    print(f"Resizing to: {target_width}x{target_height}")
    
    # Resize with high-quality resampling
    img_resized = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
    
    # Convert to monochrome bitmap
    bitmap = image_to_mono_bitmap(img_resized, bg_threshold=240)
    
    # Invert if requested (for black icons on white background)
    if args.invert:
        bitmap = [[1 - p for p in row] for row in bitmap]
    
    # Print ASCII preview
    print_ascii_preview(bitmap)
    
    # Convert to bytes
    data, final_width, final_height = bitmap_to_bytes(bitmap)
    
    # Generate Rust code
    rust_code = generate_rust_code(data, final_width, final_height, args.name)
    
    print("\n" + "=" * 60)
    print("RUST CODE (copy to display.rs):")
    print("=" * 60)
    print(rust_code)
    
    # Also save to a file
    output_name = args.name.lower() + ".rs"
    output_path = project_root / "scripts" / output_name
    with open(output_path, "w") as f:
        f.write(rust_code)
    print(f"\nAlso saved to: {output_path}")


if __name__ == "__main__":
    main()
