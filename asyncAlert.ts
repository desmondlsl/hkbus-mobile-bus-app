import { Alert } from "react-native"

export const AsyncAlert = async (info: string, message: string = "") => new Promise((resolve) => {
  Alert.alert(
    info,
    message,
    [
      {
        text: 'ok',
        onPress: () => {
          resolve('YES');
        },
      },
    ],
    { cancelable: false },
  );
});

// Prominent disclosure + consent dialog required by Google Play before
// requesting ACCESS_BACKGROUND_LOCATION. Resolves true ONLY on affirmative
// consent; the caller must not request the permission if this returns false.
export const AsyncConsent = async (
  title: string,
  message: string,
  acceptText: string = "Accept",
  declineText: string = "Don't allow",
) => new Promise<boolean>((resolve) => {
  Alert.alert(
    title,
    message,
    [
      { text: declineText, style: "cancel", onPress: () => resolve(false) },
      { text: acceptText, onPress: () => resolve(true) },
    ],
    { cancelable: false },
  );
});