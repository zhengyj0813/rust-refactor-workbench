pub fn window(input: &[u8], start: usize, end: usize) -> Option<&[u8]> {
    input.get(start..end)
}
