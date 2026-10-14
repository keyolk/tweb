// The Objective-C classes WebKit calls back into. Each is one shared instance for every view:
// a view is found from the `WKWebView` the callback names (see `app::view_id`), not from state
// in the delegate, because WebKit hands a popup the opener's configuration — and with it the
// opener's script handlers — so a per-view handler would attribute the popup's messages to the
// opener.

use crate::app;
use block2::DynBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol};
use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::NSWindow;
use objc2_foundation::{NSArray, NSError, NSString, NSURLResponse, NSURL};
use objc2_web_kit::{
    WKDownload, WKDownloadDelegate, WKFrameInfo, WKNavigation, WKNavigationAction,
    WKNavigationActionPolicy, WKNavigationDelegate, WKNavigationResponse,
    WKNavigationResponsePolicy, WKOpenPanelParameters, WKScriptMessage, WKScriptMessageHandler,
    WKUIDelegate, WKUserContentController, WKWebView, WKWebViewConfiguration, WKWindowFeatures,
};

define_class!(
    // A window that always answers "key". WebKit decides whether the page has focus — whether
    // `document.hasFocus()` is true, whether a focused input shows its caret and takes typing —
    // from its window being key. This window is never key for real: the host never activates, so
    // that it cannot take focus from the terminal the pane lives in.
    #[unsafe(super(NSWindow))]
    #[thread_kind = MainThreadOnly]
    #[name = "TwebWebKitWindow"]
    pub struct TwebWindow;

    impl TwebWindow {
        #[unsafe(method(isKeyWindow))]
        fn is_key_window(&self) -> bool {
            true
        }

        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool {
            true
        }
    }
);

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TwebWebKitScriptHandler"]
    pub struct ScriptHandler;

    unsafe impl NSObjectProtocol for ScriptHandler {}

    unsafe impl WKScriptMessageHandler for ScriptHandler {
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn did_receive(&self, _controller: &WKUserContentController, message: &WKScriptMessage) {
            app::on_script_message(message);
        }
    }
);

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TwebWebKitNavigationDelegate"]
    pub struct NavigationDelegate;

    unsafe impl NSObjectProtocol for NavigationDelegate {}

    unsafe impl WKNavigationDelegate for NavigationDelegate {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide_action(
            &self,
            _web_view: &WKWebView,
            action: &WKNavigationAction,
            handler: &DynBlock<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            // `<a download>` is a download, not a navigation.
            let download = unsafe { action.shouldPerformDownload() };
            handler.call((if download {
                WKNavigationActionPolicy::Download
            } else {
                WKNavigationActionPolicy::Allow
            },));
        }

        #[unsafe(method(webView:decidePolicyForNavigationResponse:decisionHandler:))]
        fn decide_response(
            &self,
            _web_view: &WKWebView,
            response: &WKNavigationResponse,
            handler: &DynBlock<dyn Fn(WKNavigationResponsePolicy)>,
        ) {
            // What the page cannot show is saved, as a browser would. Only the main frame:
            // a subframe that cannot show its document just shows nothing, as in Chrome.
            let save = unsafe { response.isForMainFrame() && !response.canShowMIMEType() }
                || app::is_attachment(unsafe { &response.response() });
            handler.call((if save {
                WKNavigationResponsePolicy::Download
            } else {
                WKNavigationResponsePolicy::Allow
            },));
        }

        #[unsafe(method(webView:didStartProvisionalNavigation:))]
        fn did_start(&self, web_view: &WKWebView, _navigation: Option<&WKNavigation>) {
            app::on_navigation(web_view, "start", None);
        }

        #[unsafe(method(webView:didCommitNavigation:))]
        fn did_commit(&self, web_view: &WKWebView, _navigation: Option<&WKNavigation>) {
            app::on_navigation(web_view, "commit", None);
        }

        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish(&self, web_view: &WKWebView, _navigation: Option<&WKNavigation>) {
            app::on_navigation(web_view, "finish", None);
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn did_fail(
            &self,
            web_view: &WKWebView,
            _navigation: Option<&WKNavigation>,
            error: &NSError,
        ) {
            app::on_navigation(web_view, "fail", Some(error));
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn did_fail_provisional(
            &self,
            web_view: &WKWebView,
            _navigation: Option<&WKNavigation>,
            error: &NSError,
        ) {
            app::on_navigation(web_view, "fail", Some(error));
        }

        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn did_terminate(&self, web_view: &WKWebView) {
            app::on_crash(web_view);
        }

        #[unsafe(method(webView:navigationAction:didBecomeDownload:))]
        fn action_download(
            &self,
            web_view: &WKWebView,
            _action: &WKNavigationAction,
            download: &WKDownload,
        ) {
            app::on_download(web_view, download);
        }

        #[unsafe(method(webView:navigationResponse:didBecomeDownload:))]
        fn response_download(
            &self,
            web_view: &WKWebView,
            _response: &WKNavigationResponse,
            download: &WKDownload,
        ) {
            app::on_download(web_view, download);
        }
    }
);

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TwebWebKitUIDelegate"]
    pub struct UiDelegate;

    unsafe impl NSObjectProtocol for UiDelegate {}

    unsafe impl WKUIDelegate for UiDelegate {
        #[unsafe(method_id(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
        fn create_web_view(
            &self,
            web_view: &WKWebView,
            configuration: &WKWebViewConfiguration,
            action: &WKNavigationAction,
            features: &WKWindowFeatures,
        ) -> Option<Retained<WKWebView>> {
            app::on_window_open(web_view, configuration, action, features)
        }

        #[unsafe(method(webViewDidClose:))]
        fn did_close(&self, web_view: &WKWebView) {
            app::on_page_close(web_view);
        }

        // A dialog in a pane has nowhere to appear, and a page waiting on one is frozen. They are
        // answered the way Electron's offscreen window answers them: dismissed, false, no text.
        #[unsafe(method(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn alert(
            &self,
            web_view: &WKWebView,
            message: &NSString,
            _frame: &WKFrameInfo,
            handler: &DynBlock<dyn Fn()>,
        ) {
            app::on_dialog(web_view, "alert", message);
            handler.call(());
        }

        #[unsafe(method(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn confirm(
            &self,
            web_view: &WKWebView,
            message: &NSString,
            _frame: &WKFrameInfo,
            handler: &DynBlock<dyn Fn(Bool)>,
        ) {
            app::on_dialog(web_view, "confirm", message);
            handler.call((Bool::NO,));
        }

        #[unsafe(method(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:))]
        fn prompt(
            &self,
            web_view: &WKWebView,
            message: &NSString,
            _default: Option<&NSString>,
            _frame: &WKFrameInfo,
            handler: &DynBlock<dyn Fn(*mut NSString)>,
        ) {
            app::on_dialog(web_view, "prompt", message);
            handler.call((std::ptr::null_mut(),));
        }

        #[unsafe(method(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:))]
        fn open_panel(
            &self,
            web_view: &WKWebView,
            parameters: &WKOpenPanelParameters,
            _frame: &WKFrameInfo,
            handler: &DynBlock<dyn Fn(*mut NSArray<NSURL>)>,
        ) {
            app::on_open_panel(web_view, parameters, handler);
        }
    }
);

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TwebWebKitDownloadDelegate"]
    pub struct DownloadDelegate;

    unsafe impl NSObjectProtocol for DownloadDelegate {}

    unsafe impl WKDownloadDelegate for DownloadDelegate {
        #[unsafe(method(download:decideDestinationUsingResponse:suggestedFilename:completionHandler:))]
        fn decide_destination(
            &self,
            download: &WKDownload,
            response: &NSURLResponse,
            filename: &NSString,
            handler: &DynBlock<dyn Fn(*mut NSURL)>,
        ) {
            app::on_download_destination(download, response, filename, handler);
        }

        #[unsafe(method(downloadDidFinish:))]
        fn did_finish(&self, download: &WKDownload) {
            app::on_download_end(download, None);
        }

        #[unsafe(method(download:didFailWithError:resumeData:))]
        fn did_fail(
            &self,
            download: &WKDownload,
            error: &NSError,
            _resume: Option<&objc2_foundation::NSData>,
        ) {
            app::on_download_end(download, Some(error));
        }
    }
);

macro_rules! plain_new {
    ($class:ty) => {
        impl $class {
            pub fn new(marker: MainThreadMarker) -> Retained<Self> {
                let this = Self::alloc(marker).set_ivars(());
                unsafe { msg_send![super(this), init] }
            }
        }
    };
}

plain_new!(ScriptHandler);
plain_new!(NavigationDelegate);
plain_new!(UiDelegate);
plain_new!(DownloadDelegate);
