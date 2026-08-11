#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DecodedInput {
    Key {
        key: String,
        modifier_mask: u32,
        event_kind: u32,
        text: Option<String>,
    },
    Mouse {
        code: u32,
        column: u32,
        row: u32,
        release: bool,
    },
    Private(u32),
}

#[derive(Default)]
pub(crate) struct InputDecoder {
    pending: Vec<u8>,
}

impl InputDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<DecodedInput> {
        self.pending.extend_from_slice(bytes);
        self.consume(false)
    }

    pub fn flush_escape(&mut self) -> Vec<DecodedInput> {
        self.consume(true)
    }

    pub fn has_pending_escape(&self) -> bool {
        self.pending.first() == Some(&0x1b)
    }

    fn consume(&mut self, flush_escape: bool) -> Vec<DecodedInput> {
        let mut output = Vec::new();
        loop {
            if self.pending.is_empty() {
                break;
            }
            if self.pending[0] != 0x1b {
                let end = self
                    .pending
                    .iter()
                    .position(|byte| *byte == 0x1b)
                    .unwrap_or(self.pending.len());
                let consumed = decode_text_prefix(&self.pending[..end], &mut output);
                if consumed == 0 {
                    break;
                }
                self.pending.drain(..consumed);
                continue;
            }

            match decode_escape(&self.pending) {
                EscapeResult::Complete(consumed, event) => {
                    self.pending.drain(..consumed);
                    if let Some(event) = event {
                        output.push(event);
                    }
                }
                EscapeResult::Incomplete if !flush_escape => break,
                EscapeResult::Incomplete | EscapeResult::Unknown => {
                    self.pending.remove(0);
                    output.push(key_event("Escape", 1, 1, None));
                }
            }
        }
        output
    }
}

fn key_event(key: &str, modifier_mask: u32, event_kind: u32, text: Option<String>) -> DecodedInput {
    DecodedInput::Key {
        key: key.to_string(),
        modifier_mask,
        event_kind,
        text,
    }
}

fn decode_text_prefix(bytes: &[u8], output: &mut Vec<DecodedInput>) -> usize {
    let mut offset = 0;
    while offset < bytes.len() {
        let byte = bytes[offset];
        if byte < 0x20 || byte == 0x7f {
            if let Some(event) = decode_control(byte) {
                output.push(event);
            }
            offset += 1;
            continue;
        }
        let width = utf8_char_width(byte);
        if width == 0 {
            offset += 1;
            continue;
        }
        if offset + width > bytes.len() {
            break;
        }
        let Ok(value) = std::str::from_utf8(&bytes[offset..offset + width]) else {
            offset += 1;
            continue;
        };
        let Some(character) = value.chars().next() else {
            offset += width;
            continue;
        };
        let shift = character.is_ascii_uppercase();
        output.push(key_event(
            &character.to_string(),
            if shift { 2 } else { 1 },
            1,
            Some(character.to_string()),
        ));
        offset += width;
    }
    offset
}

fn decode_control(byte: u8) -> Option<DecodedInput> {
    match byte {
        0 => Some(key_event(" ", 5, 1, None)),
        9 => Some(key_event("Tab", 1, 1, None)),
        10 | 13 => Some(key_event("Enter", 1, 1, None)),
        1..=26 => Some(key_event(&((byte + 96) as char).to_string(), 5, 1, None)),
        28 => Some(key_event("\\", 5, 1, None)),
        29 => Some(key_event("]", 5, 1, None)),
        30 => Some(key_event("^", 5, 1, None)),
        31 => Some(key_event("_", 5, 1, None)),
        127 => Some(key_event("Backspace", 1, 1, None)),
        _ => None,
    }
}

fn utf8_char_width(first: u8) -> usize {
    match first {
        0x00..=0x7f => 1,
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => 0,
    }
}

enum EscapeResult {
    Complete(usize, Option<DecodedInput>),
    Incomplete,
    Unknown,
}

fn decode_escape(bytes: &[u8]) -> EscapeResult {
    if bytes.len() == 1 {
        return EscapeResult::Incomplete;
    }
    if bytes.starts_with(b"\x1b[I") || bytes.starts_with(b"\x1b[O") {
        return EscapeResult::Complete(3, None);
    }
    if bytes.starts_with(b"\x1b[<") {
        return decode_mouse(bytes);
    }
    if bytes.starts_with(b"\x1b[") {
        return decode_csi(bytes);
    }
    if bytes.starts_with(b"\x1bO") {
        if bytes.len() < 3 {
            return EscapeResult::Incomplete;
        }
        let key = match bytes[2] {
            b'P' => "F1",
            b'Q' => "F2",
            b'R' => "F3",
            b'S' => "F4",
            b'A' => "ArrowUp",
            b'B' => "ArrowDown",
            b'C' => "ArrowRight",
            b'D' => "ArrowLeft",
            b'H' => "Home",
            b'F' => "End",
            _ => return EscapeResult::Unknown,
        };
        return EscapeResult::Complete(3, Some(key_event(key, 1, 1, None)));
    }
    EscapeResult::Unknown
}

fn decode_mouse(bytes: &[u8]) -> EscapeResult {
    let Some(end) = bytes
        .iter()
        .enumerate()
        .skip(3)
        .find(|(_, byte)| matches!(byte, b'M' | b'm'))
        .map(|(index, _)| index)
    else {
        return EscapeResult::Incomplete;
    };
    let Ok(body) = std::str::from_utf8(&bytes[3..end]) else {
        return EscapeResult::Unknown;
    };
    let values: Vec<u32> = body
        .split(';')
        .filter_map(|value| value.parse().ok())
        .collect();
    if values.len() != 3 {
        return EscapeResult::Unknown;
    }
    EscapeResult::Complete(
        end + 1,
        Some(DecodedInput::Mouse {
            code: values[0],
            column: values[1],
            row: values[2],
            release: bytes[end] == b'm',
        }),
    )
}

fn decode_csi(bytes: &[u8]) -> EscapeResult {
    let Some(end) = bytes
        .iter()
        .enumerate()
        .skip(2)
        .find(|(_, byte)| (0x40..=0x7e).contains(*byte))
        .map(|(index, _)| index)
    else {
        return EscapeResult::Incomplete;
    };
    let final_byte = bytes[end];
    let Ok(body) = std::str::from_utf8(&bytes[2..end]) else {
        return EscapeResult::Unknown;
    };
    let consumed = end + 1;

    if final_byte == b'u' {
        let mut fields = body.split(';');
        let Some(codepoint) = fields
            .next()
            .and_then(|value| value.split(':').next())
            .and_then(|value| value.parse::<u32>().ok())
        else {
            return EscapeResult::Unknown;
        };
        let mut modifier = fields.next().unwrap_or("1").split(':');
        let modifier_mask: u32 = modifier
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or(1);
        let event_kind = modifier
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or(1);
        let text = fields
            .next()
            .map(|value| {
                value
                    .split(':')
                    .filter_map(|part| part.parse().ok().and_then(char::from_u32))
                    .collect::<String>()
            })
            .filter(|value| !value.is_empty());
        let Some(key) = key_name(codepoint) else {
            return EscapeResult::Unknown;
        };
        let text = text.or_else(|| {
            let bits = modifier_mask.saturating_sub(1);
            (key.chars().count() == 1 && bits & (4 | 8 | 32) == 0).then(|| key.clone())
        });
        return EscapeResult::Complete(
            consumed,
            Some(key_event(&key, modifier_mask, event_kind, text)),
        );
    }

    if final_byte == b'~' {
        let fields: Vec<&str> = body.split(';').collect();
        if fields.len() == 1 {
            if let Ok(code) = fields[0].parse::<u32>() {
                if (5001..=5010).contains(&code) {
                    return EscapeResult::Complete(consumed, Some(DecodedInput::Private(code)));
                }
                if let Some(key) = tilde_key(code) {
                    return EscapeResult::Complete(consumed, Some(key_event(key, 1, 1, None)));
                }
            }
        }
        if fields.first() == Some(&"27") && fields.len() == 3 {
            if let (Ok(modifier), Ok(codepoint)) = (fields[1].parse(), fields[2].parse()) {
                if let Some(key) = key_name(codepoint) {
                    return EscapeResult::Complete(
                        consumed,
                        Some(key_event(&key, modifier, 1, None)),
                    );
                }
            }
        }
        if fields.len() <= 2 {
            if let Ok(code) = fields[0].parse::<u32>() {
                if let Some(key) = tilde_key(code) {
                    let modifier = fields
                        .get(1)
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(1);
                    return EscapeResult::Complete(
                        consumed,
                        Some(key_event(key, modifier, 1, None)),
                    );
                }
            }
        }
        return EscapeResult::Unknown;
    }

    let key = match final_byte {
        b'A' => "ArrowUp",
        b'B' => "ArrowDown",
        b'C' => "ArrowRight",
        b'D' => "ArrowLeft",
        b'H' => "Home",
        b'F' => "End",
        _ => return EscapeResult::Unknown,
    };
    let modifier = body
        .split(';')
        .nth(1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(1);
    EscapeResult::Complete(consumed, Some(key_event(key, modifier, 1, None)))
}

fn key_name(codepoint: u32) -> Option<String> {
    let named = match codepoint {
        27 | 57344 => Some("Escape"),
        13 | 57345 => Some("Enter"),
        9 | 57346 => Some("Tab"),
        127 | 57347 => Some("Backspace"),
        57348 => Some("Insert"),
        57349 => Some("Delete"),
        57350 => Some("ArrowLeft"),
        57351 => Some("ArrowRight"),
        57352 => Some("ArrowUp"),
        57353 => Some("ArrowDown"),
        57354 => Some("PageUp"),
        57355 => Some("PageDown"),
        57356 => Some("Home"),
        57357 => Some("End"),
        _ => None,
    };
    named
        .map(str::to_string)
        .or_else(|| char::from_u32(codepoint).map(|character| character.to_string()))
}

fn tilde_key(code: u32) -> Option<&'static str> {
    match code {
        1 => Some("Home"),
        2 => Some("Insert"),
        3 => Some("Delete"),
        4 => Some("End"),
        5 => Some("PageUp"),
        6 => Some("PageDown"),
        11 => Some("F1"),
        12 => Some("F2"),
        13 => Some("F3"),
        14 => Some("F4"),
        15 => Some("F5"),
        17 => Some("F6"),
        18 => Some("F7"),
        19 => Some("F8"),
        20 => Some("F9"),
        21 => Some("F10"),
        23 => Some("F11"),
        24 => Some("F12"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{DecodedInput, InputDecoder};

    #[test]
    fn decodes_actual_shortcut_sequences() {
        let mut decoder = InputDecoder::default();
        assert_eq!(decoder.push(b"f"), vec![key("f", 1)]);
        assert_eq!(decoder.push(b"\x1b[74;2u"), vec![key("J", 2)]);
        assert_eq!(
            decoder.push(b"\x1b[5001~"),
            vec![DecodedInput::Private(5001)]
        );
        assert_eq!(decoder.push(b"\x1b[27;5;119~"), vec![key("w", 5)]);
    }

    #[test]
    fn waits_for_split_escape_sequence() {
        let mut decoder = InputDecoder::default();
        assert!(decoder.push(b"\x1b[").is_empty());
        assert_eq!(decoder.push(b"57353u"), vec![key("ArrowDown", 1)]);
        assert!(decoder.push(b"\x1b").is_empty());
        assert_eq!(decoder.flush_escape(), vec![key("Escape", 1)]);
    }

    #[test]
    fn decodes_mouse_and_utf8() {
        let mut decoder = InputDecoder::default();
        assert_eq!(
            decoder.push(b"\x1b[<0;10;5M\x1b[<0;10;5m"),
            vec![
                DecodedInput::Mouse {
                    code: 0,
                    column: 10,
                    row: 5,
                    release: false
                },
                DecodedInput::Mouse {
                    code: 0,
                    column: 10,
                    row: 5,
                    release: true
                },
            ]
        );
        // A Korean syllable as a multi-byte UTF-8 fixture: the decoder has to keep it whole.
        assert_eq!(decoder.push("한".as_bytes()), vec![key("한", 1)]);
    }

    #[test]
    fn converts_control_bytes_to_modified_keys() {
        let mut decoder = InputDecoder::default();
        assert_eq!(decoder.push(&[0x03]), vec![key("c", 5)]);
        assert_eq!(decoder.push(b"\r\t"), vec![key("Enter", 1), key("Tab", 1)]);
        assert_eq!(decoder.push(&[0x7f]), vec![key("Backspace", 1)]);
    }

    fn key(value: &str, modifier_mask: u32) -> DecodedInput {
        DecodedInput::Key {
            key: value.to_string(),
            modifier_mask,
            event_kind: 1,
            text: if value.chars().count() == 1 && modifier_mask < 5 {
                Some(value.to_string())
            } else {
                None
            },
        }
    }
}
