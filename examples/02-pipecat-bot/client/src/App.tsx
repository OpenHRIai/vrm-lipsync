import {
  ConnectButton,
  ControlBar,
  ErrorCard,
  FullScreenContainer,
  PipecatAppBase,
  SpinLoader,
  UserAudioControl,
  type PipecatBaseChildProps,
} from "@pipecat-ai/voice-ui-kit";
import { VRMAvatar, useLipsyncFeed, type LipsyncFeed } from "@openhri/vrm-lipsync";
import { useEffect, useState } from "react";

/**
 * The avatar, wired to the bot's lipsync stream.
 *
 * `useLipsyncFeed` subscribes to RTVI `server-message`s and demuxes the ones
 * tagged `bot-tts-lipsync`, so nothing beyond a stock Pipecat client is
 * required. It has to sit inside the client provider that `PipecatAppBase`
 * establishes, which is why this is its own component rather than inline.
 */
/**
 * Live A/V trim.
 *
 * `offsetTrimMs` is a plain mutable field on the feed, so it takes effect on
 * the very next rendered frame — no reconnect. That matters because sync is
 * judged by ear against continuous speech, and the bot only serves one
 * conversation per process start.
 */
function TrimSlider({ feed }: { feed: LipsyncFeed }) {
  const [trim, setTrim] = useState(0);

  useEffect(() => {
    feed.offsetTrimMs = trim;
  }, [feed, trim]);

  return (
    <div className="flex items-center gap-3 text-sm">
      <label htmlFor="trim" className="whitespace-nowrap opacity-70">
        A/V trim
      </label>
      <input
        id="trim"
        type="range"
        min={-200}
        max={200}
        step={5}
        value={trim}
        onChange={(e) => setTrim(Number(e.target.value))}
        className="w-56"
      />
      <code className="w-20 tabular-nums">
        {trim > 0 ? `+${trim}` : trim} ms
      </code>
      <button className="opacity-60 underline" onClick={() => setTrim(0)}>
        reset
      </button>
      <span className="opacity-50">
        &larr; mouth earlier &middot; mouth later &rarr;
      </span>
    </div>
  );
}

function Avatar({ feed }: { feed: LipsyncFeed }) {
  return (
    <VRMAvatar
      modelUrl="/RikiMinami.vrm"
      idleAnimationUrl="/idle_loop.vrma"
      source={feed}
      interactive
      className="flex-1 min-h-0"
      fallback={
        <div className="absolute inset-0 grid place-items-center">
          <SpinLoader />
        </div>
      }
    />
  );
}

/**
 * Everything that needs the Pipecat client provider.
 *
 * The feed lives here rather than inside `Avatar` so the trim slider can
 * write to the same instance the renderer is reading.
 */
function Session({
  handleConnect,
  handleDisconnect,
}: Pick<PipecatBaseChildProps, "handleConnect" | "handleDisconnect">) {
  const feed = useLipsyncFeed();

  // Dev hook: inspect the live stream from the console, e.g.
  //   lipsyncFeed.statsSnapshot(lipsyncFeed.now())
  if (import.meta.env.DEV) Object.assign(window, { lipsyncFeed: feed });

  return (
    <div className="flex h-full w-full flex-col gap-4 p-4">
      <Avatar feed={feed} />
      <div className="flex flex-col items-center gap-3">
        <TrimSlider feed={feed} />
        <ControlBar>
          <ConnectButton
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
          />
          <UserAudioControl />
        </ControlBar>
      </div>
    </div>
  );
}

export function App() {
  return (
    <FullScreenContainer>
      <PipecatAppBase
        transportType="smallwebrtc"
        connectParams={{ webrtcUrl: "/api/offer" }}
      >
        {({
          client,
          error,
          handleConnect,
          handleDisconnect,
        }: PipecatBaseChildProps) => {
          // Dev hook: raw client access, e.g.
          //   pipecatClient.on("serverMessage", console.log)
          if (import.meta.env.DEV) Object.assign(window, { pipecatClient: client });

          return error ? (
            <ErrorCard>{error}</ErrorCard>
          ) : !client ? (
            <SpinLoader />
          ) : (
            <Session
              handleConnect={handleConnect}
              handleDisconnect={handleDisconnect}
            />
          );
        }}
      </PipecatAppBase>
    </FullScreenContainer>
  );
}
