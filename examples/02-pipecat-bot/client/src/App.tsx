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
import { VRMAvatar, useLipsyncFeed } from "@openhri/vrm-lipsync";

/**
 * The avatar, wired to the bot's lipsync stream.
 *
 * `useLipsyncFeed` subscribes to RTVI `server-message`s and demuxes the ones
 * tagged `bot-tts-lipsync`, so nothing beyond a stock Pipecat client is
 * required. It has to sit inside the client provider that `PipecatAppBase`
 * establishes, which is why this is its own component rather than inline.
 */
function Avatar() {
  const feed = useLipsyncFeed();

  // Dev hook: inspect the live stream from the console, e.g.
  //   lipsyncFeed.statsSnapshot(lipsyncFeed.now())
  if (import.meta.env.DEV) Object.assign(window, { lipsyncFeed: feed });

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
            <div className="flex h-full w-full flex-col gap-4 p-4">
              <Avatar />
              <ControlBar className="self-center">
                <ConnectButton
                  onConnect={handleConnect}
                  onDisconnect={handleDisconnect}
                />
                <UserAudioControl />
              </ControlBar>
            </div>
          );
        }}
      </PipecatAppBase>
    </FullScreenContainer>
  );
}
