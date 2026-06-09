import "react-native-url-polyfill/auto";
import * as NavigationBar from "expo-navigation-bar";
import * as SplashScreen from "expo-splash-screen";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { StatusBar } from "expo-status-bar";
import {
  AppState,
  BackHandler,
  Platform,
  StyleSheet,
  Share,
  Text,
  TouchableOpacity,
  ToastAndroid,
  useColorScheme,
  View,
  Linking,
} from "react-native";
import {
  Accuracy,
  getCurrentPositionAsync,
  getForegroundPermissionsAsync,
  hasServicesEnabledAsync,
  LocationPermissionResponse,
  PermissionStatus as LocationPermissionStatus,
  requestForegroundPermissionsAsync,
  watchHeadingAsync,
  watchPositionAsync,
} from "expo-location";
import { WebView } from "react-native-webview";
import type { WebViewNavigation } from "react-native-webview";
import {
  PermissionStatus as TrackingPermissionStatus,
  useTrackingPermissions,
  requestTrackingPermissionsAsync,
} from "expo-tracking-transparency";
import { postAlarmToWebView, toggleAlarm } from "./stopAlarm";
import { AsyncConsent } from "./asyncAlert";
import * as ExpoLinking from "expo-linking";
import AsyncStorage from '@react-native-async-storage/async-storage';

SplashScreen.preventAutoHideAsync();

const useAppIsInForeground = () => {
  const appState = useRef(AppState.currentState);
  const [appIsInForeground, setAppIsInForeground] = useState(true);
  useEffect(() => {
    const handler = AppState.addEventListener('change', async nextAppState => {
      if (
        appState.current.match(/inactive|background/) &&
        nextAppState === 'active'
      ) {
        setAppIsInForeground(true);
      }
      if (
        appState.current === 'active' &&
        nextAppState.match(/inactive|background/)
      ) {
        setAppIsInForeground(false);
      }
      appState.current = nextAppState;
    });

    return () => handler.remove();
  }, []);

  return appIsInForeground;
};

export default function App() {
  const appIsInForeground = useAppIsInForeground();
  const rawColorScheme = useColorScheme();
  // RN 0.85's useColorScheme() now returns 'light' | 'dark' | 'unspecified'
  // (previously nullable). Normalize back to 'light' | 'dark' | null so the
  // existing fallbacks and the value injected into the web app behave as before.
  const systemColorScheme =
    rawColorScheme === "light" || rawColorScheme === "dark"
      ? rawColorScheme
      : null;
  const [webAppActualColorMode, setWebAppActualColorMode] = useState<
    "light" | "dark"
  >(systemColorScheme || "dark");

  const url = ExpoLinking.useLinkingURL();

  const [locationPermission, setLocationPermission] =
    useState<LocationPermissionResponse | null>(null);

  useEffect(() => {
    (async () => {
      const existing = await getForegroundPermissionsAsync();
      if (existing.granted) {
        setLocationPermission(existing);
        return;
      }
      // Google Play's User Data policy requires a prominent disclosure shown
      // BEFORE any location permission is requested. This app also uses
      // background location (arrival reminder), so the disclosure states that
      // location may be collected even when the app is closed or not in use.
      if (Platform.OS === "android" && existing.canAskAgain) {
        const consented = await AsyncConsent(
          "位置資料使用 / Location data",
          "「巴士到站預報」會使用你的位置資料，以顯示附近的巴士路線及車站，"
            + "並可在你接近所選車站時提示到站，即使應用程式已關閉或沒有在使用中。"
            + "位置資料只用於上述功能。\n\n"
            + "hkbus.app collects location data to show nearby bus routes and stops, "
            + "and to alert you when you are approaching your selected stop — even when "
            + "the app is closed or not in use. Location is used only for these features.",
          "允許 / Allow",
          "不允許 / Don't allow",
        );
        if (!consented) {
          // User declined the disclosure: do not request the permission. Load
          // the app without location features.
          setLocationPermission({
            ...existing,
            status: LocationPermissionStatus.DENIED,
            granted: false,
          });
          return;
        }
      }
      setLocationPermission(await requestForegroundPermissionsAsync());
    })();
  }, []);

  // requestForegroundPermissionsAsync may sometimes get stuck on Android when the permission has already been granted before
  // const [locationPermission] = useForegroundPermissions({
  //   get: true,
  //   request: true,
  // });

  const [trackingPermission] = useTrackingPermissions({
    get: true,
    request: false,
  });

  const [geolocationStatus, setGeolocationStatus] = useState<
    "granted" | "closed" | null
  >(null);

  const webViewUrl = useRef<string>("");
  const readyToExit = useRef<Boolean>(false)
  const webViewRef = useRef<WebView>(null);

  // Handle Back press behaviour
  useEffect(() => {
    if (Platform.OS !== "android") return;

    const handler = BackHandler.addEventListener("hardwareBackPress", function () {
      if (webViewRef.current) {
        const url = new URL(webViewUrl.current);
        if (["/", "/zh", "/en"].includes(url.pathname)) {
          // Pressing back on the home page, trying to close the app
          if (readyToExit.current) {
            // Back already pressed recently, exiting
            BackHandler.exitApp();
          } else {
            // Back pressed for the first time, show confirmation
            ToastAndroid.show("Press back again to exit", ToastAndroid.SHORT);
            readyToExit.current = true
            // Allow 5 seconds for the user to press back again
            setTimeout(() => {
              readyToExit.current = false
            }, 5000);
          }
        } else {
          // Not on the home page, go back
          webViewRef.current.goBack();
        }
        return true;
      }
      return true;
    });
    
    return () => {
      handler?.remove()
    }
  }, []);

  const handleWebViewNavigationStateChange = useCallback((
    newNavState: WebViewNavigation
  ) => {
    webViewUrl.current = newNavState.url;
  }, []);

  useEffect(() => {
    let headingSubscription = { remove: () => {} };
    let positionSubscription = { remove: () => {} };
    if (
      locationPermission?.status === LocationPermissionStatus.GRANTED &&
      geolocationStatus === "granted" &&
      appIsInForeground
    ) {
      hasServicesEnabledAsync().then(enabled => {
        if (!enabled) return;
        getCurrentPositionAsync({ accuracy: Accuracy.BestForNavigation })
          .then(({ coords: { latitude, longitude } }) => {
            webViewRef?.current?.postMessage(
              JSON.stringify({ lat: latitude, lng: longitude, type: "location" })
            );
          });
        watchHeadingAsync(({ accuracy, trueHeading }) => {
          webViewRef?.current?.postMessage(
            JSON.stringify({
              accuracy,
              degree: 360 - trueHeading,
              type: "compass",
            })
          );
        }).then((s) => (headingSubscription = s));
        watchPositionAsync(
          { accuracy: Accuracy.BestForNavigation },
          ({ coords: { latitude, longitude } }) => {
            webViewRef?.current?.postMessage(
              JSON.stringify({ lat: latitude, lng: longitude, type: "location" })
            );
          }
        ).then((s) => (positionSubscription = s));
      })
    }
    return () => {
      headingSubscription.remove();
      positionSubscription.remove();
    };
  }, [locationPermission?.status, geolocationStatus, appIsInForeground]);

  const handleOnMessage = useCallback((e: any) => {
    try {
      const {
        nativeEvent: { data },
      } = e;
      const message = JSON.parse(data) as any;
      if (message.type === "start-geolocation") {
        if (locationPermission?.granted) {
          setGeolocationStatus("granted");
        } else if (message.force || locationPermission?.canAskAgain) {
          requestForegroundPermissionsAsync().then(({ status }) => {
            setGeolocationStatus(status === LocationPermissionStatus.GRANTED ? "granted" : "closed");
          });
        } else {
          setGeolocationStatus("closed");
        }
      } else if (message.type === "stop-geolocation") {
        setGeolocationStatus("closed");
      } else if (message.type === "share") {
        Share.share(
          {
            title: message?.value?.title ?? "",
            message: [message?.value?.text, message?.value?.url]
              .filter(Boolean)
              .join(" "),
            url: message?.value?.url,
          },
          {
            dialogTitle: message?.value?.title,
            subject: message?.value?.title,
          }
        );
      } else if (message.type === "stop-alarm") {
        toggleAlarm(message.value)
          .then(() => 
            postAlarmToWebView(webViewRef)
          );
      } else if (message.type === "color-mode") {
        setWebAppActualColorMode(message.value);
      } else if (message.type === "setItem") {
        if ( message?.value?.value === null || message?.value?.value === undefined ) {
          AsyncStorage.removeItem(message?.value)
        } else {
          AsyncStorage.setItem(message?.value?.key, message?.value?.value)
        }
      } else if (message.type === "removeItem") {
        AsyncStorage.removeItem(message?.value)
      } else if (message.type === "clear") {
        AsyncStorage.clear()
      } else if (message.type === 'multiGet') {
        AsyncStorage.getAllKeys()
          .then(keys => AsyncStorage.multiGet(keys))
          .then(kvs => {
            webViewRef?.current?.postMessage(
              JSON.stringify({
                type: "initStorage",
                kvs: kvs.reduce((acc, [k, v]) => {
                  if ( k === null || v === null ) return acc;
                  acc[k] = v;
                  return acc
                }, {} as Record<string, string>)
              })
            );
          })
      }
    } catch (err) {
      console.log("UNKNOWN message:", e);
    }
  }, [locationPermission]);

  const readyToLoad = useMemo<boolean>(() => {
    if (
      locationPermission === null ||
      locationPermission.status === undefined ||
      locationPermission.status === LocationPermissionStatus.UNDETERMINED
    ) {
      return false;
    }
    setGeolocationStatus(locationPermission.granted ? "granted" : "closed")
    return true;
  }, [locationPermission, locationPermission?.status]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextAppState) => {
      if (Platform.OS !== "ios") return;
      if (
        nextAppState === "active" &&
        (trackingPermission === null ||
          trackingPermission?.status === undefined ||
          trackingPermission?.status === TrackingPermissionStatus.UNDETERMINED)
      ) {
        requestTrackingPermissionsAsync();
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if ( readyToLoad ) {
      webViewRef?.current?.postMessage(
        JSON.stringify({
          type: "geoPermission",
          value: geolocationStatus,
        })
      );
      console.log("post geoPermission: "+JSON.stringify(geolocationStatus))
      postAlarmToWebView(webViewRef)
    }
  }, [readyToLoad, geolocationStatus]);

  const runFirst = useMemo(
    () => `
    window.RnOs = "${Platform.OS}";
    window.iOSRNWebView = ${Platform.OS === 'ios'};
    window.stopAlarm = true;
    ${
      Platform.OS === "ios"
        ? `window.iOSTracking = ${
            trackingPermission?.status === TrackingPermissionStatus.GRANTED
          };`
        : ""
    }
    if (navigator.share == null) {
      navigator.share = (param) => {
         window.ReactNativeWebView.postMessage(JSON.stringify({type: 'share', value: param}));
      };
    };

    window.systemColorSchemeCallbacks = [];
    window.systemColorScheme = new Proxy(
      { value: ${JSON.stringify(systemColorScheme)} },
      {
        set(target, property, value) {
          const result = Reflect.set(target, property, value);
          if (result) {
            window.systemColorSchemeCallbacks.forEach((callback) =>
              callback(value)
            );
          } else {
            console.error(
              "Failed to set window.systemColorScheme.",
              property,
              "to",
              value
            );
          }
          return result;
        },
      }
    );

    true; // note: this is required, or you'll sometimes get silent failures
  `,
    [trackingPermission]
  );

  useEffect(() => {
    webViewRef.current?.injectJavaScript(
      `if (window.systemColorScheme && typeof window.systemColorScheme === "object") {
        window.systemColorScheme.value = ${JSON.stringify(systemColorScheme)};
      }`
    );
  }, [systemColorScheme]);

  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }
    // Under SDK 54+ mandatory edge-to-edge, the navigation bar is transparent
    // and its background can no longer be set (the web app draws behind it via
    // its own safe-area insets). Only the button/icon style is controllable.
    NavigationBar.setStyle(
      webAppActualColorMode === "light" ? "dark" : "light"
    );
  }, [webAppActualColorMode]);

  const handleContentTerminate = useCallback(() => {
    webViewRef.current?.reload();
  }, []);

  if (!readyToLoad) {
    return <></>;
  }

  const uri = url?.startsWith("https://hkbus.app") ? url : "https://hkbus.app/";

  return (
    <>
      <StatusBar
        style={
          Platform.OS === "android"
            ? webAppActualColorMode === "light"
              ? "dark"
              : "light"
            : "light"
        }
      />
      <View
        style={[
          styles.container,
          {
            backgroundColor:
              webAppActualColorMode === "light" ? "#FEDB00" : "#000",
          },
        ]}
      >
          <WebView
            ref={webViewRef}
            style={styles.webview}
            source={{ uri }}
            cacheEnabled
            cacheMode="LOAD_CACHE_ELSE_NETWORK"
            limitsNavigationsToAppBoundDomains={true}
            renderError={(_domain, _code, desc) => (
              <View
                style={[
                  styles.errorContainer,
                  {
                    backgroundColor:
                      webAppActualColorMode === "light" ? "#FEDB00" : "#000",
                  },
                ]}
              >
                <Text
                  style={[
                    styles.errorTitle,
                    { color: webAppActualColorMode === "light" ? "#000" : "#fff" },
                  ]}
                >
                  未能連線 / Offline
                </Text>
                <Text
                  style={[
                    styles.errorText,
                    { color: webAppActualColorMode === "light" ? "#000" : "#ccc" },
                  ]}
                >
                  無法連接伺服器，請檢查網絡連線。{"\n"}
                  Can't reach the server. Please check your connection.
                </Text>
                <TouchableOpacity
                  style={[
                    styles.retryButton,
                    {
                      backgroundColor:
                        webAppActualColorMode === "light" ? "#000" : "#FEDB00",
                    },
                  ]}
                  onPress={() => webViewRef.current?.reload()}
                >
                  <Text
                    style={[
                      styles.retryButtonText,
                      {
                        color: webAppActualColorMode === "light" ? "#FEDB00" : "#000",
                      },
                    ]}
                  >
                    重試 / Retry
                  </Text>
                </TouchableOpacity>
              </View>
            )}
            pullToRefreshEnabled
            onMessage={handleOnMessage}
            injectedJavaScriptBeforeContentLoaded={runFirst}
            onShouldStartLoadWithRequest={(request) => {
              if (!request.url.startsWith(uri)) {
                Linking.openURL(request.url);
                return false;
              }
              return true;
            }}
            onContentProcessDidTerminate={handleContentTerminate}
            bounces={false}
            overScrollMode="content"
            onNavigationStateChange={handleWebViewNavigationStateChange}
            onLoadEnd={() => {
              SplashScreen.hide()
              webViewRef?.current?.postMessage(
                JSON.stringify({
                  type: "geoPermission",
                  value: geolocationStatus,
                })
              );
              console.log("post geoPermission: "+JSON.stringify(geolocationStatus))
              postAlarmToWebView(webViewRef)
            }}
            startInLoadingState
          />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: "100%",
    backgroundColor: "#000",
    color: "#fff",
  },
  webview: {
    width: "100%",
    height: "100%",
  },
  loadingView: {
    backgroundColor: "black",
    width: "100%",
    height: "100%",
  },
  errorContainer: {
    flex: 1,
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  errorTitle: {
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 12,
    textAlign: "center",
  },
  errorText: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
    marginBottom: 28,
  },
  retryButton: {
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 24,
  },
  retryButtonText: {
    fontSize: 16,
    fontWeight: "600",
  },
});
