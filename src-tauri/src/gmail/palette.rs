//! Gmail's label colour palette: the 8x8 grid Gmail web offers, plus the other values
//! the API still accepts.

/// Gmail web's picker grid, row-major.
pub const LABEL_BACKGROUNDS: [&str; 64] = [
    "#000000", "#434343", "#666666", "#999999", "#cccccc", "#efefef", "#f3f3f3", "#ffffff",
    "#fb4c2f", "#ffad47", "#fad165", "#16a766", "#43d692", "#4a86e8", "#a479e2", "#f691b3",
    "#f6c5be", "#ffe6c7", "#fef1d1", "#b9e4d0", "#c6f3de", "#c9daf8", "#e4d7f5", "#fcdee8",
    "#efa093", "#ffd6a2", "#fce8b3", "#89d3b2", "#a0eac9", "#a4c2f4", "#d0bcf1", "#fbc8d9",
    "#e66550", "#ffbc6b", "#fcda83", "#44b984", "#68dfa9", "#6d9eeb", "#b694e8", "#f7a7c0",
    "#cc3a21", "#eaa041", "#f2c960", "#149e60", "#3dc789", "#3c78d8", "#8e63ce", "#e07798",
    "#ac2b16", "#cf8933", "#d5ae49", "#0b804b", "#2a9c68", "#285bac", "#653e9b", "#b65775",
    "#822111", "#a46a21", "#aa8831", "#076239", "#1a764d", "#1c4587", "#41236d", "#83334c",
];

/// Every colour the API accepts: the 64 grid colours plus 38 the grid does not show.
pub const LABEL_ALLOWED: &[&str] = &[
    "#000000", "#434343", "#666666", "#999999", "#cccccc", "#efefef", "#f3f3f3", "#ffffff",
    "#fb4c2f", "#ffad47", "#fad165", "#16a766", "#43d692", "#4a86e8", "#a479e2", "#f691b3",
    "#f6c5be", "#ffe6c7", "#fef1d1", "#b9e4d0", "#c6f3de", "#c9daf8", "#e4d7f5", "#fcdee8",
    "#efa093", "#ffd6a2", "#fce8b3", "#89d3b2", "#a0eac9", "#a4c2f4", "#d0bcf1", "#fbc8d9",
    "#e66550", "#ffbc6b", "#fcda83", "#44b984", "#68dfa9", "#6d9eeb", "#b694e8", "#f7a7c0",
    "#cc3a21", "#eaa041", "#f2c960", "#149e60", "#3dc789", "#3c78d8", "#8e63ce", "#e07798",
    "#ac2b16", "#cf8933", "#d5ae49", "#0b804b", "#2a9c68", "#285bac", "#653e9b", "#b65775",
    "#822111", "#a46a21", "#aa8831", "#076239", "#1a764d", "#1c4587", "#41236d", "#83334c",
    "#464646", "#e7e7e7", "#0d3472", "#b6cff5", "#0d3b44", "#98d7e4", "#3d188e", "#e3d7ff",
    "#711a36", "#fbd3e0", "#8a1c0a", "#f2b2a8", "#7a2e0b", "#ffc8af", "#7a4706", "#ffdeb5",
    "#594c05", "#fbe983", "#684e07", "#fdedc1", "#0b4f30", "#b3efd3", "#04502e", "#a2dcc1",
    "#c2c2c2", "#4986e7", "#2da2bb", "#b99aff", "#994a64", "#f691b2", "#ff7537", "#ffad46",
    "#662e37", "#ebdbde", "#cca6ac", "#094228", "#42d692", "#16a765",
];

/// Whether the Gmail API accepts `hex` as a label colour (case-insensitive).
pub fn is_allowed(hex: &str) -> bool {
    LABEL_ALLOWED.iter().any(|c| c.eq_ignore_ascii_case(hex))
}

/// WCAG relative luminance of `#rrggbb`; unparseable input counts as black.
fn luminance(hex: &str) -> f64 {
    let h = hex.trim_start_matches('#');
    let channel = |i: usize| {
        let v = h
            .get(i..i + 2)
            .and_then(|s| u8::from_str_radix(s, 16).ok())
            .unwrap_or(0);
        let c = f64::from(v) / 255.0;
        if c <= 0.03928 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/// `#ffffff` or `#000000`, whichever contrasts more (WCAG) with `background`.
pub fn text_for(background: &str) -> &'static str {
    let l = luminance(background);
    let white = 1.05 / (l + 0.05);
    let black = (l + 0.05) / 0.05;
    if white > black {
        "#ffffff"
    } else {
        "#000000"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_readable_text() {
        assert_eq!(text_for("#16a766"), "#000000");
        assert_eq!(text_for("#000000"), "#ffffff");
        assert_eq!(text_for("#fef1d1"), "#000000");
    }

    #[test]
    fn allowed_is_case_insensitive_and_closed() {
        assert!(is_allowed("#16A766"));
        assert!(!is_allowed("#123456"));
        assert!(LABEL_BACKGROUNDS.iter().all(|c| is_allowed(c)));
        assert_eq!(LABEL_ALLOWED.len(), 64 + 38);
        assert_eq!(&LABEL_ALLOWED[..64], &LABEL_BACKGROUNDS[..]);
    }
}
