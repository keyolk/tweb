use uuid::Uuid;

pub(crate) fn bridge_script() -> (String, String) {
    let token = Uuid::new_v4().simple().to_string();
    let token_json = serde_json::to_string(&token).expect("UUID serializes to JSON");
    let script = format!(
        r#"
(() => {{
  const token = {token};
  let requestSerial = 0;
  const listeners = new Map();
  const ipcRenderer = {{
    send(action, message) {{
      const payload = action === 'tweb-shortcut' ? message : {{ action, value: message }};
      if (action === 'tweb-preload-ready') payload.value = {{ title: document.title, url: location.href }};
      const request = new Image();
      request.hidden = true;
      request.src = `tweb-action://${{token}}/?payload=${{encodeURIComponent(JSON.stringify(payload))}}&nonce=${{++requestSerial}}`;
      (document.documentElement || document).append(request);
      setTimeout(() => request.remove(), 1000);
    }},
    on(channel, listener) {{
      const group = listeners.get(channel) || [];
      group.push(listener);
      listeners.set(channel, group);
    }},
  }};
  Object.defineProperty(window, '__twebReceive', {{
    configurable: true,
    value(channel, value) {{
      for (const listener of listeners.get(channel) || []) listener({{}}, value);
    }},
  }});
{body}
  const reportMeta = () => ipcRenderer.send('tweb-shortcut', {{
    action: 'page-meta', value: {{ title: document.title, url: location.href }},
  }});
  const watchTitle = () => {{
    reportMeta();
    const title = document.querySelector('title');
    if (title) new MutationObserver(reportMeta).observe(title, {{ childList: true, subtree: true, characterData: true }});
  }};
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', watchTitle, {{ once: true }});
  else watchTitle();
}})();
"#,
        token = token_json,
        body = include_str!("preload.js.inc"),
    );
    (script, token)
}

#[cfg(test)]
mod tests {
    use super::bridge_script;

    #[test]
    fn bridge_contains_modal_runtime_and_authenticated_invoke() {
        let (script, token) = bridge_script();
        assert!(script.contains("startHints"));
        assert!(script.contains("showTabList"));
        assert!(script.contains("tweb-action://"));
        assert!(script.contains("nonce=${++requestSerial}"));
        assert!(script.contains("__tweb_caret__"));
        assert!(script.contains("__twebTerminalWheel"));
        assert!(script.contains("captureTerminalEditable"));
        assert!(script.contains("suppressMouseProbe"));
        assert!(script.contains("moveTextControlCaret"));
        assert!(script.contains("requestImplicitSubmit"));
        assert!(script.contains("singleLineTextarea"));
        assert!(script.contains("scrollBy({ left: -90"));
        assert!(script.contains("scrollBy({ left: 90"));
        assert!(script.contains(&token));
    }
}
