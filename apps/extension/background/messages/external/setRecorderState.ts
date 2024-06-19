import type { PlasmoMessaging } from '@plasmohq/messaging';
import type { RecorderState, Result } from '@repo/shared';
import { WhisperingError, effectToResult } from '@repo/shared';
import arrowsCounterclockwise from 'data-base64:~assets/arrows_counterclockwise.png';
import redLargeSquare from 'data-base64:~assets/red_large_square.png';
import studioMicrophone from 'data-base64:~assets/studio_microphone.png';
import { Effect } from 'effect';
import { renderErrorAsToast } from '~lib/errors';
import { ToastServiceBgswLive } from '~lib/services/ToastServiceBgswLive';
import { extensionStorageService } from '~lib/services/extension-storage';

const iconPaths = {
	IDLE: studioMicrophone,
	RECORDING: redLargeSquare,
	LOADING: arrowsCounterclockwise,
} as const satisfies Record<RecorderState, string>;

const setRecorderState = (recorderState: RecorderState) =>
	Effect.gen(function* () {
		yield* extensionStorageService['whispering-recording-state'].set(recorderState);
		const path = iconPaths[recorderState];
		yield* Effect.tryPromise({
			try: () => chrome.action.setIcon({ path }),
			catch: (error) =>
				new WhisperingError({
					title: `Error setting icon to ${recorderState} icon`,
					description: error instanceof Error ? error.message : `Error: ${error}`,
					error,
				}),
		});
	});

export type RequestBody = { recorderState: RecorderState };

export type ResponseBody = Result<void>;

const handler: PlasmoMessaging.MessageHandler<RequestBody, ResponseBody> = ({ body }, res) =>
	Effect.gen(function* () {
		if (!body?.recorderState) {
			return yield* new WhisperingError({
				title: 'Error invoking setRecorderState command',
				description: 'RecorderState must be provided in the request body of the message',
			});
		}
		yield* setRecorderState(body.recorderState);
	}).pipe(
		Effect.tapError(renderErrorAsToast),
		Effect.provide(ToastServiceBgswLive),
		effectToResult,
		Effect.map(res.send),
		Effect.runPromise,
	);

export default handler;
