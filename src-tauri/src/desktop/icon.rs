//! Small code-drawn envelope with an unread badge, legible at tray sizes.
use tauri::image::Image;

pub fn image(unread: i64) -> Image<'static> {
    let mut pixels = vec![0u8; 32 * 32 * 4];
    let mut dot = |x: usize, y: usize, color: [u8; 4]| {
        if x < 32 && y < 32 {
            pixels[(y * 32 + x) * 4..(y * 32 + x) * 4 + 4].copy_from_slice(&color);
        }
    };
    let ink = if cfg!(target_os = "macos") {
        [0, 0, 0, 255]
    } else {
        [135, 156, 166, 255]
    };
    for x in 3..29 {
        for w in 0..2 {
            dot(x, 7 + w, ink);
            dot(x, 24 - w, ink);
        }
    }
    for y in 7..25 {
        for w in 0..2 {
            dot(3 + w, y, ink);
            dot(28 - w, y, ink);
        }
    }
    for x in 5..27 {
        let y = 9 + (x - 5).min(26 - x) / 2;
        dot(x, y, ink);
        dot(x, y + 1, ink);
    }
    if unread > 0 && !cfg!(target_os = "macos") {
        for y in 17..32 {
            for x in 12..32 {
                dot(x, y, [188, 39, 53, 255]);
            }
        }
        let label = if unread > 99 {
            "99+".into()
        } else {
            unread.to_string()
        };
        for (index, c) in label.chars().enumerate() {
            let rows: [u8; 5] = match c {
                '0' => [7, 5, 5, 5, 7],
                '1' => [2, 6, 2, 2, 7],
                '2' => [7, 1, 7, 4, 7],
                '3' => [7, 1, 7, 1, 7],
                '4' => [5, 5, 7, 1, 1],
                '5' => [7, 4, 7, 1, 7],
                '6' => [7, 4, 7, 5, 7],
                '7' => [7, 1, 1, 1, 1],
                '8' => [7, 5, 7, 5, 7],
                '9' => [7, 5, 7, 1, 7],
                _ => [0, 2, 7, 2, 0],
            };
            let left = 22 - label.len() * 2 + index * 4;
            for (y, row) in rows.iter().enumerate() {
                for x in 0..3 {
                    if row & (1 << (2 - x)) != 0 {
                        dot(left + x, 22 + y, [255, 255, 255, 255]);
                    }
                }
            }
        }
    }
    Image::new_owned(pixels, 32, 32)
}
