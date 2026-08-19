/**
 * Push on completion.
 *
 * A local notification here, because a prototype has no push server. The production path is the
 * same call site: the worker that finishes the analysis sends to APNs/FCM with the analysis id and
 * nothing else.
 *
 * The payload deliberately carries no result. A lock-screen preview reading "Melanoma, 72%" is a
 * disclosure to whoever happens to be holding the phone, and notification content is the easiest
 * place in a health app to leak a diagnosis by accident.
 */
import * as Notifications from 'expo-notifications';
import type { InferenceResult } from '@caliper/core';

Notifications.setNotificationHandler({
  // `shouldShowAlert` was split into banner and list in recent SDKs; both are set so the
  // behaviour is explicit rather than inherited from a default that has already changed once.
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export async function requestNotificationPermission(): Promise<boolean> {
  try {
    const existing = await Notifications.getPermissionsAsync();
    if (existing.granted) return true;
    const asked = await Notifications.requestPermissionsAsync();
    return asked.granted;
  } catch {
    return false;
  }
}

export async function notifyComplete(result: InferenceResult): Promise<void> {
  try {
    const granted = await requestNotificationPermission();
    if (!granted) return;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Assessment ready',
        // Acuity only. Never the condition, never the confidence.
        body:
          result.acuity === 'urgent'
            ? 'Your result is ready and recommends prompt review. Open Caliper to read it.'
            : 'Your result is ready. Open Caliper to read it.',
      },
      trigger: null,
    });
  } catch {
    // A notification that cannot be delivered is not a reason to fail the analysis.
  }
}
