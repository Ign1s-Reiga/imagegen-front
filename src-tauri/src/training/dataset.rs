//! Photographs in a training project: importing copies, reading their size
//! and orientation, thumbnails, and the one conversion a training image goes
//! through.
//!
//! Originals are copied into the project byte for byte and never changed.
//! What a run trains on is made from them by `convert_for_training`: EXIF
//! orientation applied, the optional crop applied, pixels as 8-bit RGB,
//! written as PNG. PNG from these pixels carries no metadata, so camera and
//! location data never leave the machine.

use std::io::Cursor;

use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits, metadata::Orientation};
use sha2::{Digest, Sha256};

use super::db::Crop;
use crate::error::{Error, Result};

/// Named in each run's snapshot, so a later change to the conversion is
/// never mistaken for the one a run used.
pub const CONVERSION: &str =
    "imagegen-convert-v1: exif orientation, crop, rgb8, png without metadata";

pub const THUMB_SIZE: u32 = 384;
/// Images sent to a captioning service are no larger than this.
pub const CAPTION_SIZE: u32 = 1024;

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// The extension a stored copy gets, from what the bytes are.
pub fn stored_ext(bytes: &[u8]) -> Option<&'static str> {
    match image::guess_format(bytes).ok()? {
        ImageFormat::Jpeg => Some("jpg"),
        ImageFormat::Png => Some("png"),
        ImageFormat::WebP => Some("webp"),
        _ => None,
    }
}

pub fn is_supported_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".jpg", ".jpeg", ".png", ".webp"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// What reading a photograph found.
#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    /// Size as displayed, after orientation.
    pub width: u32,
    pub height: u32,
    pub orientation: u8,
    pub has_location: bool,
}

fn reader(bytes: &[u8]) -> Result<ImageReader<Cursor<&[u8]>>> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|err| Error::msg(err.to_string()))?;
    // Photographs from phones are large but well under these.
    let mut limits = Limits::default();
    limits.max_image_width = Some(20_000);
    limits.max_image_height = Some(20_000);
    limits.max_alloc = Some(1 << 30);
    reader.limits(limits);
    Ok(reader)
}

/// Decodes the photograph with its EXIF orientation applied.
pub fn decode(bytes: &[u8]) -> Result<(DynamicImage, Probe)> {
    let mut decoder = reader(bytes)?
        .into_decoder()
        .map_err(|err| Error::msg(format!("cannot read this image: {err}")))?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let exif = decoder.exif_metadata().ok().flatten();
    let mut image = DynamicImage::from_decoder(decoder)
        .map_err(|err| Error::msg(format!("cannot read this image: {err}")))?;
    image.apply_orientation(orientation);
    let probe = Probe {
        width: image.width(),
        height: image.height(),
        orientation: orientation.to_exif(),
        has_location: exif.as_deref().is_some_and(exif_has_gps),
    };
    Ok((image, probe))
}

/// Whether EXIF data points at a GPS block (tag 0x8825 in its first IFD).
pub fn exif_has_gps(exif: &[u8]) -> bool {
    let tiff = exif.strip_prefix(b"Exif\0\0").unwrap_or(exif);
    if tiff.len() < 8 {
        return false;
    }
    let big = match &tiff[..2] {
        b"MM" => true,
        b"II" => false,
        _ => return false,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let b = tiff.get(at..at + 2)?;
        Some(if big {
            u16::from_be_bytes([b[0], b[1]])
        } else {
            u16::from_le_bytes([b[0], b[1]])
        })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let b = tiff.get(at..at + 4)?;
        Some(if big {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        })
    };
    let Some(ifd) = u32_at(4).map(|v| v as usize) else {
        return false;
    };
    let Some(count) = u16_at(ifd) else {
        return false;
    };
    (0..count as usize).any(|i| u16_at(ifd + 2 + i * 12) == Some(0x8825))
}

fn encode_jpeg(image: &DynamicImage, quality: u8) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
    image
        .to_rgb8()
        .write_with_encoder(encoder)
        .map_err(|err| Error::msg(err.to_string()))?;
    Ok(out)
}

pub fn thumbnail(image: &DynamicImage) -> Result<Vec<u8>> {
    encode_jpeg(&image.thumbnail(THUMB_SIZE, THUMB_SIZE), 85)
}

/// A copy for a captioning service: oriented, cropped as it will train,
/// reduced, and with no metadata.
pub fn caption_copy(bytes: &[u8], crop: Option<&Crop>) -> Result<Vec<u8>> {
    let (image, _) = decode(bytes)?;
    let image = apply_crop(image, crop);
    encode_jpeg(&image.thumbnail(CAPTION_SIZE, CAPTION_SIZE), 88)
}

/// The pixel rectangle a normalized crop covers, at least one pixel.
pub fn crop_rect(crop: &Crop, width: u32, height: u32) -> (u32, u32, u32, u32) {
    let x = ((crop.x * width as f64).round() as u32).min(width.saturating_sub(1));
    let y = ((crop.y * height as f64).round() as u32).min(height.saturating_sub(1));
    let w = ((crop.width * width as f64).round() as u32).clamp(1, width - x);
    let h = ((crop.height * height as f64).round() as u32).clamp(1, height - y);
    (x, y, w, h)
}

fn apply_crop(image: DynamicImage, crop: Option<&Crop>) -> DynamicImage {
    match crop {
        Some(c) => {
            let (x, y, w, h) = crop_rect(c, image.width(), image.height());
            image.crop_imm(x, y, w, h)
        }
        None => image,
    }
}

/// The training copy of a photograph (see the module notes). The same
/// original and crop always give the same bytes.
pub fn convert_for_training(bytes: &[u8], crop: Option<&Crop>) -> Result<(Vec<u8>, u32, u32)> {
    let (image, _) = decode(bytes)?;
    let image = DynamicImage::ImageRgb8(apply_crop(image, crop).to_rgb8());
    let mut out = Vec::new();
    image
        .write_to(Cursor::new(&mut out), ImageFormat::Png)
        .map_err(|err| Error::msg(err.to_string()))?;
    Ok((out, image.width(), image.height()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut img = RgbImage::new(width, height);
        img.put_pixel(0, 0, Rgb([255, 0, 0]));
        let mut out = Vec::new();
        DynamicImage::ImageRgb8(img)
            .write_to(Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    /// A JPEG whose EXIF says "rotate 90" (orientation 6), optionally with a
    /// GPS pointer.
    fn jpeg_with_exif(width: u32, height: u32, gps: bool) -> Vec<u8> {
        let jpeg = encode_jpeg(&DynamicImage::ImageRgb8(RgbImage::new(width, height)), 90).unwrap();
        let mut tiff = b"II*\0\x08\0\0\0".to_vec();
        let entries: u16 = if gps { 2 } else { 1 };
        tiff.extend(entries.to_le_bytes());
        tiff.extend([0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0]); // Orientation = 6
        if gps {
            tiff.extend([0x25, 0x88, 4, 0, 1, 0, 0, 0, 0, 0, 0, 0]); // GPS IFD pointer
        }
        tiff.extend([0, 0, 0, 0]);
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend(tiff);
        let mut out = jpeg[..2].to_vec(); // SOI
        out.extend([0xFF, 0xE1]);
        out.extend(((app1.len() + 2) as u16).to_be_bytes());
        out.extend(app1);
        out.extend(&jpeg[2..]);
        out
    }

    #[test]
    fn applies_orientation_and_finds_location() {
        let bytes = jpeg_with_exif(40, 20, true);
        let (image, probe) = decode(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (20, 40));
        assert_eq!(probe.orientation, 6);
        assert!(probe.has_location);
        assert!(
            !decode(&jpeg_with_exif(40, 20, false))
                .unwrap()
                .1
                .has_location
        );
    }

    #[test]
    fn training_copy_drops_metadata_and_is_reproducible() {
        let bytes = jpeg_with_exif(40, 20, true);
        let (a, w, h) = convert_for_training(&bytes, None).unwrap();
        let (b, _, _) = convert_for_training(&bytes, None).unwrap();
        assert_eq!(a, b);
        assert_eq!((w, h), (20, 40));
        assert_eq!(image::guess_format(&a).unwrap(), ImageFormat::Png);
        assert!(!a.windows(4).any(|win| win == b"eXIf" || win == b"Exif"));
    }

    #[test]
    fn crops_on_the_oriented_image() {
        let crop = Crop {
            x: 0.5,
            y: 0.0,
            width: 0.5,
            height: 0.5,
        };
        let (_, w, h) = convert_for_training(&png(100, 60), Some(&crop)).unwrap();
        assert_eq!((w, h), (50, 30));
        assert_eq!(
            crop_rect(
                &Crop {
                    x: 0.999,
                    y: 0.999,
                    width: 0.5,
                    height: 0.5
                },
                10,
                10
            ),
            (9, 9, 1, 1)
        );
    }

    #[test]
    fn reports_undecodable_files() {
        assert!(decode(b"not an image").is_err());
        assert_eq!(stored_ext(&png(2, 2)), Some("png"));
        assert_eq!(stored_ext(b"GIF89a....."), None);
        assert!(is_supported_name("IMG_1.JPEG"));
        assert!(!is_supported_name("IMG_1.heic"));
    }
}
