// Deep link #/auth/<session id> (Telegram's "Continue sign-in" button: {public}/mini/#/auth/<id>): the sign-in sheet
// over Activity, where active sign-ins are listed. Closing the sheet goes back (or to Activity without history).
import { goBack } from '../router';
import { AuthSheet, preloadAuthSheet } from '../signin';
import { ActivityScreen } from './ActivityScreen';

// the form's chunk downloads together with this screen
void preloadAuthSheet();

export function AuthScreen({ sessionId }: { sessionId: string }) {
  return (
    <>
      <ActivityScreen />
      <AuthSheet sessionId={sessionId} onClose={() => goBack('/activity')} />
    </>
  );
}
