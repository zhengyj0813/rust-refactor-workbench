pub fn pick<'a>(left: &'a str, right: &'a str, threshold: usize) -> &'a str {
    if left.len() >= threshold { left } else { right }
}
