import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { ToolChip } from "@/components/ToolChip";
import { Button } from "@/components/ui/button";
import {
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { ArrowDownIcon, ArrowUpIcon, SquareIcon } from "lucide-react";
import type { FC } from "react";

// The chat in the sidebar, cut down from assistant-ui's stock Thread to what
// this app uses. The agents take text only and the conversation is a single
// line saved to sessionStorage, so there are no attachments, voice, editing,
// reloads or branches. Reasoning is off (showThinking: false), and tool calls
// render as ToolChips.

export const Thread: FC = () => (
  <ThreadPrimitive.Root className="bg-background flex h-full flex-col">
    <ThreadPrimitive.Viewport className="relative flex flex-1 flex-col overflow-y-auto">
      <div className="flex flex-1 flex-col px-4 pt-4">
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <p className="text-muted-foreground mb-4 px-1">
            Ask me about the reviews, have me find and open one, or open a new review and I&apos;ll help you write it.
          </p>
        </AuiIf>

        {/* An agent turn can arrive as several assistant messages (tool calls,
            then text), so those sit close together and turns get the space. */}
        <div className="mb-6 flex flex-col empty:hidden [&>*+*]:mt-5 [&>[data-role=assistant]+[data-role=assistant]]:mt-1">
          <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
        </div>

        <ThreadPrimitive.ViewportFooter className="bg-background sticky bottom-0 mt-auto flex flex-col gap-2 pb-4">
          <ThreadPrimitive.ScrollToBottom asChild>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Scroll to the latest message"
              className="bg-background absolute -top-10 self-center rounded-full shadow-sm disabled:invisible"
            >
              <ArrowDownIcon />
            </Button>
          </ThreadPrimitive.ScrollToBottom>
          <AuiIf condition={(s) => s.thread.isEmpty && s.composer.isEmpty}>
            <Suggestions />
          </AuiIf>
          <Composer />
        </ThreadPrimitive.ViewportFooter>
      </div>
    </ThreadPrimitive.Viewport>
  </ThreadPrimitive.Root>
);

const ThreadMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  // A run that only called browser tools leaves an assistant message with
  // nothing in it; once it's done there's nothing to show.
  const empty = useAuiState((s) => s.message.content.length === 0 && s.message.status?.type !== "running");
  if (role === "user") return <UserMessage />;
  return empty ? null : <AssistantMessage />;
};

// The per-screen suggestions from AppShell, shown before the first message.
const Suggestions: FC = () => (
  <div className="flex flex-col">
    <ThreadPrimitive.Suggestions>
      {() => (
        <SuggestionPrimitive.Trigger send asChild>
          <button
            type="button"
            className="hover:bg-muted focus-visible:ring-ring/50 rounded-md px-2 py-1.5 text-start text-sm outline-none focus-visible:ring-2"
          >
            <SuggestionPrimitive.Title />{" "}
            <SuggestionPrimitive.Description className="text-muted-foreground empty:hidden" />
          </button>
        </SuggestionPrimitive.Trigger>
      )}
    </ThreadPrimitive.Suggestions>
  </div>
);

const Composer: FC = () => (
  <ComposerPrimitive.Root className="bg-muted/30 border-foreground/10 focus-within:border-foreground/25 flex items-end gap-2 rounded-2xl border p-2 transition-[border-color]">
    <ComposerPrimitive.Input
      placeholder="Ask about reviews…"
      rows={1}
      enterKeyHint="send"
      aria-label="Message input"
      className="placeholder:text-muted-foreground/60 max-h-40 min-h-8 flex-1 resize-none bg-transparent px-2 py-1 text-base leading-6 outline-none"
    />
    <AuiIf condition={(s) => !s.composer.canCancel}>
      <ComposerPrimitive.Send asChild>
        <Button size="icon-sm" className="rounded-full" aria-label="Send message">
          <ArrowUpIcon />
        </Button>
      </ComposerPrimitive.Send>
    </AuiIf>
    <AuiIf condition={(s) => s.composer.canCancel}>
      <ComposerPrimitive.Cancel asChild>
        <Button size="icon-sm" className="rounded-full" aria-label="Stop the assistant">
          <SquareIcon className="fill-current" />
        </Button>
      </ComposerPrimitive.Cancel>
    </AuiIf>
  </ComposerPrimitive.Root>
);

const AssistantMessage: FC = () => (
  <MessagePrimitive.Root data-role="assistant" className="px-1 leading-relaxed wrap-break-word">
    <MessagePrimitive.GroupedParts groupBy={() => null}>
      {({ part }) => {
        switch (part.type) {
          case "text":
            return <MarkdownText />;
          case "tool-call":
            return part.toolUI ?? <ToolChip {...part} />;
          case "indicator":
            return (
              <span className="text-muted-foreground animate-pulse" aria-label="Assistant is working">
                ●
              </span>
            );
          default:
            return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="border-destructive bg-destructive/10 text-destructive mt-2 rounded-md border p-3 text-sm">
        <ErrorPrimitive.Message className="line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  </MessagePrimitive.Root>
);

const UserMessage: FC = () => (
  <MessagePrimitive.Root data-role="user" className="ms-10 self-end">
    <div className="bg-muted rounded-2xl px-4 py-2 wrap-break-word">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>
);
