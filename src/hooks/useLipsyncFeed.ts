import { RTVIEvent } from "@pipecat-ai/client-js";
import { useRTVIClientEvent } from "@pipecat-ai/client-react";
import { useCallback, useEffect, useMemo } from "react";

import { LipsyncFeed } from "../lipsync/feed";
import { parseLipsyncData } from "../lipsync/protocol";

export interface UseLipsyncFeedOptions {
  /** A/V trim in ms; positive delays the mouth relative to the audio. */
  offsetTrimMs?: number;
  /**
   * Only needed for a server that neither uses the default 200ms release lead
   * nor states its own on the wire. Must match its `scheduling_lead_ms`.
   */
  schedulingLeadSec?: number;
  /** Seconds the last pose is held after an utterance's final keyframe. */
  restHoldSec?: number;
  /** Time constant, in seconds, for easing to rest after that hold. */
  restEaseSec?: number;
}

/**
 * Subscribes to the bot's lipsync stream and returns a feed to render from.
 *
 * Lipsync batches arrive as ordinary RTVI `server-message`s, so nothing beyond
 * a stock Pipecat client is required — `parseLipsyncData` demuxes on
 * `data.type === "bot-tts-lipsync"` and ignores every other server message.
 *
 * Must be called inside a `PipecatClientProvider`.
 */
export function useLipsyncFeed(options: UseLipsyncFeedOptions = {}): LipsyncFeed {
  const feed = useMemo(
    () =>
      new LipsyncFeed({
        schedulingLeadSec: options.schedulingLeadSec,
        restHoldSec: options.restHoldSec,
        restEaseSec: options.restEaseSec,
      }),
    // Rebuilding the feed mid-call would drop the queue; the lead is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    feed.offsetTrimMs = options.offsetTrimMs ?? 0;
  }, [feed, options.offsetTrimMs]);

  useRTVIClientEvent(
    RTVIEvent.ServerMessage,
    useCallback(
      (data: unknown) => {
        const batch = parseLipsyncData(data);
        if (batch) feed.ingest(batch);
      },
      [feed],
    ),
  );

  // On barge-in the server discards the unplayed audio and its batches, but
  // some may already be in flight; cutting stops the mouth with the voice.
  // At a natural turn end the cut's grace window keeps everything still due,
  // and if the bot only paused mid-turn the feed resumes on the next batch.
  useRTVIClientEvent(
    RTVIEvent.BotStoppedSpeaking,
    useCallback(() => feed.cut(), [feed]),
  );

  // A disconnect leaves the feed anchored to a dead utterance clock.
  useRTVIClientEvent(
    RTVIEvent.Disconnected,
    useCallback(() => feed.reset(), [feed]),
  );

  return feed;
}
