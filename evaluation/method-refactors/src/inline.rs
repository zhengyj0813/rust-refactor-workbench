pub fn doubled_next(mut next: impl FnMut() -> u32) -> u32 {
    double(next())
}

fn double(value: u32) -> u32 {
    value + value
}
