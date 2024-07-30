import { goto } from '$app/navigation';
import { ClipboardService } from '$lib/services/ClipboardService';
import { ClipboardServiceDesktopLive } from '$lib/services/ClipboardServiceDesktopLive';
import { ClipboardServiceWebLive } from '$lib/services/ClipboardServiceWebLive';
import { NotificationServiceDesktopLive } from '$lib/services/NotificationServiceDesktopLive';
import { NotificationServiceWebLive } from '$lib/services/NotificationServiceWebLive';
import { RecordingsDbService, type Recording } from '$lib/services/RecordingDbService';
import { RecordingsDbServiceLiveIndexedDb } from '$lib/services/RecordingDbServiceIndexedDbLive.svelte';
import { toast } from '$lib/services/ToastService';
import { renderErrorAsToast } from '$lib/services/renderErrorAsToast';
import {
	NotificationService,
	TranscriptionService,
	TranscriptionServiceWhisperingLive,
	WhisperingError,
} from '@repo/shared';
import { save } from '@tauri-apps/api/dialog';
import { writeBinaryFile } from '@tauri-apps/api/fs';
import { type } from '@tauri-apps/api/os';
import { invoke } from '@tauri-apps/api/tauri';
import { Effect, Either, Option } from 'effect';
import { nanoid } from 'nanoid/non-secure';
import { recorderState } from './recorder.svelte';
import { settings } from './settings.svelte';

export const recordings = Effect.gen(function* () {
	const { notify, clear } = yield* NotificationService;
	const recordingsDb = yield* RecordingsDbService;
	const transcriptionService = yield* TranscriptionService;
	const clipboardService = yield* ClipboardService;

	let recordings = $state<Recording[]>([]);
	const updateRecording = (recording: Recording) =>
		Effect.gen(function* () {
			yield* recordingsDb.updateRecording(recording);
			recordings = recordings.map((r) => (r.id === recording.id ? recording : r));
		});

	const syncDbToRecordingsState = Effect.gen(function* () {
		recordings = yield* recordingsDb.getAllRecordings;
	}).pipe(Effect.catchAll(renderErrorAsToast));
	syncDbToRecordingsState.pipe(Effect.runPromise);

	return {
		get value() {
			return recordings;
		},
		addRecording: (recording: Recording) =>
			Effect.gen(function* () {
				yield* recordingsDb.addRecording(recording);
				recordings.push(recording);
			}).pipe(Effect.catchAll(renderErrorAsToast)),
		updateRecording: (recording: Recording) =>
			Effect.gen(function* () {
				yield* updateRecording(recording);
				yield* toast({
					variant: 'success',
					title: 'Recording updated!',
					description: 'Your recording has been updated successfully.',
				});
			}).pipe(Effect.catchAll(renderErrorAsToast), Effect.runPromise),
		deleteRecordingById: (id: string) =>
			Effect.gen(function* () {
				yield* recordingsDb.deleteRecordingById(id);
				recordings = recordings.filter((recording) => recording.id !== id);
				yield* toast({
					variant: 'success',
					title: 'Recording deleted!',
					description: 'Your recording has been deleted successfully.',
				});
			}).pipe(Effect.catchAll(renderErrorAsToast), Effect.runPromise),
		deleteRecordingsById: (ids: string[]) =>
			Effect.gen(function* () {
				yield* recordingsDb.deleteRecordingsById(ids);
				recordings = recordings.filter((recording) => !ids.includes(recording.id));
				yield* toast({
					variant: 'success',
					title: 'Recordings deleted!',
					description: 'Your recordings have been deleted successfully.',
				});
			}).pipe(Effect.catchAll(renderErrorAsToast), Effect.runPromise),
		transcribeRecording: (id: string) =>
			Effect.gen(function* () {
				const transcribingInProgressId = nanoid();
				yield* toast({
					id: transcribingInProgressId,
					variant: 'loading',
					title: 'Transcribing recording...',
					description: 'Your recording is being transcribed.',
				});
				if (recorderState.value !== 'RECORDING') {
					recorderState.value = 'LOADING';
				}
				const isVisible = !document.hidden;

				if (!isVisible) {
					yield* notify({
						id: transcribingInProgressId,
						title: 'Transcribing recording...',
						description: 'Your recording is being transcribed.',
						action: {
							label: 'Go to recordings',
							goto: '/recordings',
						},
					});
				}

				const transcribedText = yield* Effect.gen(function* () {
					const maybeRecording = yield* recordingsDb.getRecording(id);
					if (Option.isNone(maybeRecording)) {
						return yield* new WhisperingError({
							title: `Recording with id ${id} not found`,
							description: 'Please try again.',
						});
					}
					const recording = maybeRecording.value;
					yield* updateRecording({ ...recording, transcriptionStatus: 'TRANSCRIBING' });
					const transcriptionResult = yield* Effect.either(
						transcriptionService.transcribe(recording.blob, settings),
					);
					if (Either.isLeft(transcriptionResult)) {
						yield* updateRecording({ ...recording, transcriptionStatus: 'UNPROCESSED' });
						const error = transcriptionResult.left;
						return yield* error;
					}
					const transcribedText = transcriptionResult.right;
					yield* Effect.all(
						[
							updateRecording({ ...recording, transcribedText, transcriptionStatus: 'DONE' }),
							Effect.sync(() => {
								if (recorderState.value !== 'RECORDING') {
									recorderState.value = 'IDLE';
								}
							}),
							toast({
								variant: 'success',
								id: transcribingInProgressId,
								title: 'Transcription complete!',
								description: 'Check it out in your recordings',
								action: {
									label: 'Go to recordings',
									onClick: () => goto('/recordings'),
								},
							}),
							clear(transcribingInProgressId),
							notify({
								id: nanoid(),
								title: 'Transcription complete!',
								description: 'Click to check it out in your recordings',
								action: {
									label: 'Go to recordings',
									goto: '/recordings',
								},
							}),
						],
						{ concurrency: 'unbounded' },
					);
					return transcribedText;
				}).pipe(
					Effect.tapError((error) =>
						renderErrorAsToast(error, { toastId: transcribingInProgressId }),
					),
					Effect.catchAll(() => Effect.succeed('')),
				);

				if (transcribedText === '') return;

				// Copy transcription to clipboard if enabled
				if (settings.isCopyToClipboardEnabled) {
					yield* clipboardService.setClipboardText(transcribedText);
					yield* toast({
						variant: 'success',
						title: 'Copied transcription to clipboard!',
						description: transcribedText,
						descriptionClass: 'line-clamp-2',
					});
				}

				// Paste transcription if enabled
				if (settings.isPasteContentsOnSuccessEnabled) {
					const isMacos = window.__TAURI__ && (yield* Effect.promise(type)) === 'Darwin';
					if (!isMacos) {
						yield* clipboardService.writeText(transcribedText);
						yield* toast({
							variant: 'success',
							title: 'Pasted transcription!',
							description: transcribedText,
							descriptionClass: 'line-clamp-2',
						});
						return;
					}
					const isAccessibilityEnabled = yield* Effect.tryPromise({
						try: () =>
							invoke<boolean>('is_macos_accessibility_enabled', { askIfNotAllowed: false }),
						catch: (error) =>
							new WhisperingError({
								title: 'Unable to ensure accessibility is enabled',
								description: error instanceof Error ? error.message : `Error: ${error}`,
								error,
							}),
					});
					if (!isAccessibilityEnabled) {
						yield* toast({
							variant: 'warning',
							title: 'Please enable or re-enable accessibility to paste transcriptions!',
							description:
								'Accessibility must be enabled or re-enabled for Whispering after install or update. Follow the link below for instructions.',
							action: {
								label: 'Open Directions',
								onClick: () => goto('/macos-enable-accessibility'),
							},
						});
						return;
					}
					yield* clipboardService.writeText(transcribedText);
					yield* toast({
						variant: 'success',
						title: 'Pasted transcription!',
						description: transcribedText,
						descriptionClass: 'line-clamp-2',
					});
				}
			}),
		downloadRecording: (id: string) =>
			Effect.gen(function* () {
				const maybeRecording = yield* recordingsDb.getRecording(id);
				if (Option.isNone(maybeRecording)) {
					return yield* new WhisperingError({
						title: `Recording with id ${id} not found`,
						description: 'Please try again.',
					});
				}
				const recording = maybeRecording.value;
				if (window.__TAURI__) {
					const path = yield* Effect.promise(() =>
						save({
							filters: [
								{
									name: `whispering_recording_${recording.id}`,
									extensions: ['ogg'],
								},
							],
						}),
					);
					if (path === null) return;
					const contents = new Uint8Array(
						yield* Effect.promise(() => recording.blob.arrayBuffer()),
					);
					yield* Effect.tryPromise({
						try: () => writeBinaryFile({ path, contents }),
						catch: (error) =>
							new WhisperingError({
								title: 'Error saving recording',
								description: 'Please try again.',
								error: error,
							}),
					});
				} else {
					if (recording.blob) {
						const url = URL.createObjectURL(recording.blob);
						const a = document.createElement('a');
						a.style.display = 'none';
						a.href = url;
						a.download = `whispering_recording_${recording.id}.wav`; // Adjust the file extension if needed

						document.body.appendChild(a);
						a.click();

						// Clean up
						window.URL.revokeObjectURL(url);
						document.body.removeChild(a);
					}
				}
			}).pipe(Effect.catchAll(renderErrorAsToast), Effect.runPromise),
		copyRecordingText: (recording: Recording) =>
			Effect.gen(function* () {
				if (recording.transcribedText === '') return;
				yield* clipboardService.setClipboardText(recording.transcribedText);
				yield* toast({
					variant: 'success',
					title: 'Copied transcription to clipboard!',
					description: recording.transcribedText,
					descriptionClass: 'line-clamp-2',
				});
			}).pipe(Effect.catchAll(renderErrorAsToast), Effect.runPromise),
		copyRecordingsTextById: (recordingIds: string[]) =>
			Effect.gen(function* () {
				const transcriptions = recordingIds
					.map((id) => recordings.find((r) => r.id === id))
					.filter((recording) => recording !== undefined)
					.map((recording) => recording.transcribedText)
					.filter((transcription) => transcription !== '');
				const text = transcriptions.join('\n\n');
				yield* clipboardService.setClipboardText(text);
				yield* toast({
					variant: 'success',
					title: 'Copied transcriptions to clipboard!',
					description: text,
					descriptionClass: 'line-clamp-2',
				});
			}).pipe(Effect.catchAll(renderErrorAsToast), Effect.runPromise),
	};
}).pipe(
	Effect.provide(RecordingsDbServiceLiveIndexedDb),
	Effect.provide(TranscriptionServiceWhisperingLive),
	Effect.provide(window.__TAURI__ ? ClipboardServiceDesktopLive : ClipboardServiceWebLive),
	Effect.provide(window.__TAURI__ ? NotificationServiceDesktopLive : NotificationServiceWebLive),
	Effect.runSync,
);
