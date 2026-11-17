pub fn pick<'a>(input: &'a str, prefix: &str) -> Option<&'a str> {
    input.strip_prefix(prefix).filter(|rest| !rest.is_empty())
}
