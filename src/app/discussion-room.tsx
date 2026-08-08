"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  HARD_GENERATION_TIMEOUT_MS,
  RECOVERY_LEASE_GRACE_MS,
} from "@/discussion/budgets";
import {
  DiscussionIdentifierSchema,
  DiscussionResponseSchema,
  DiscussionTopicSchema,
  ErrorResponseSchema,
  NextTurnRequestSchema,
  TOPIC_MAX_LENGTH,
  speakerForTurn,
  type DiscussionState,
  type ProductErrorCode,
  type Speaker,
} from "@/discussion/contracts";
import { Transcript } from "./components/transcript";
import {
  LifecycleStatus,
  derivePhase,
} from "./components/lifecycle-status";
import { DiscussionSynthesis } from "./components/synthesis";
import {
  combinedErrorCopy,
  errorFamilyForCode,
  fallbackErrorForStatus,
  malformedServerDataError,
  networkLossError,
  type DiscussionErrorCopy,
  type DiscussionErrorFamily,
} from "./discussion-error";

/**
 * Client-side observation horizon for a hydrated Discussion that is still
 * generating server-side. The poll exists to surface the server's own
 * progress (and final state) without ever claiming a Turn; beyond the cap the
 * page hands control back to a reload.
 *
 * The cap is derived from the authoritative server lifecycle bound, not a
 * client-invented deadline: a legitimate generation may run for the full
 * configured hard timeout (`HARD_GENERATION_TIMEOUT_MS`), and a persisted
 * `generating` state cannot outlive the recovery lease of its attempt
 * (`generation timeout + RECOVERY_LEASE_GRACE_MS`) while the server is
 * reachable. The client must never stop observing an attempt the server can
 * still legitimately consider active, so the horizon covers the hard bound:
 * at most 300 s of generation plus the 60 s recovery margin.
 */
const HYDRATION_POLL_INTERVAL_MS = 2_000;
const HYDRATION_POLL_LIMIT = Math.ceil(
  (HARD_GENERATION_TIMEOUT_MS + RECOVERY_LEASE_GRACE_MS) /
    HYDRATION_POLL_INTERVAL_MS,
);

/**
 * Durable per-browser identities. sessionStorage (not memory) is deliberate:
 * the whole point is that an ambiguous Start response or a Turn failure
 * survives a reload. Keys are namespaced and versioned so a stale layout can
 * never be mistaken for a current one.
 */
const PENDING_START_KEY = "agent-discussion-room:pending-start";
const PENDING_TURN_KEY = "agent-discussion-room:pending-turn";
const FOCUS_TOPIC_ON_CREATE_KEY = "agent-discussion-room:focus-topic-on-create";

interface PendingStartIdentity {
  requestId: string;
  topic: string;
}

interface PendingTurnIdentity {
  discussionId: string;
  requestId: string;
}

function readSessionStorage(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionStorage(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // sessionStorage may be unavailable (private mode, embedded contexts);
    // the feature degrades to per-load recovery, never to duplicate Starts.
  }
}

function removeSessionStorage(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Same as above: nothing to remove.
  }
}

function readPendingStart(): PendingStartIdentity | null {
  const raw = readSessionStorage(PENDING_START_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as PendingStartIdentity).requestId === "string" &&
      typeof (parsed as PendingStartIdentity).topic === "string"
    ) {
      return parsed as PendingStartIdentity;
    }
  } catch {
    // Corrupt entry: treat as absent; a fresh identity replaces it.
  }
  return null;
}

function readPendingTurn(): PendingTurnIdentity | null {
  const raw = readSessionStorage(PENDING_TURN_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as PendingTurnIdentity).discussionId === "string" &&
      typeof (parsed as PendingTurnIdentity).requestId === "string"
    ) {
      return parsed as PendingTurnIdentity;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Whether the durable state allows the completion synthesis to be resumed:
 * the Discussion is naturally completed and either has no synthesis yet (a
 * crash between the final Turn commit and the synthesis claim, or a legacy
 * pre-synthesis Discussion) or carries a retryable synthesis failure.
 * Deliberately ignores any browser-held request identity: the server owns
 * the retry decision from persisted state alone.
 */
function synthesisResumable(discussion: DiscussionState): boolean {
  return (
    discussion.status === "completed" &&
    (discussion.synthesis === undefined ||
      (discussion.synthesis.status === "failed" &&
        discussion.synthesis.failure.retryable))
  );
}

function topicError(topic: string): string {
  if (topic.trim().length === 0) {
    return "Enter a Discussion Topic before starting.";
  }
  if (topic.length > TOPIC_MAX_LENGTH) {
    return `Shorten the Topic to ${TOPIC_MAX_LENGTH} characters or fewer.`;
  }
  return "Use plain text without tabs, line breaks, or control characters.";
}

/** Copy shown to the participant in the alert region. */
interface ParticipantError {
  message: string;
  family: DiscussionErrorFamily;
}

function networkError(family: DiscussionErrorFamily): ParticipantError {
  return { message: combinedErrorCopy(networkLossError()), family };
}

type DiscussionRequestResult =
  | { ok: true; discussion: DiscussionState }
  | { ok: false; error: ParticipantError; retryable: boolean };

/**
 * Decodes a Discussion HTTP response into either the authoritative
 * Discussion state or stable participant copy. Server error envelopes are
 * trusted; malformed or missing envelopes fall back to status-based copy so
 * internals never leak.
 */
async function readDiscussionResponse(
  response: Response,
): Promise<DiscussionRequestResult> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (response.ok) {
      return {
        ok: false,
        retryable: false,
        error: {
          message: combinedErrorCopy(malformedServerDataError()),
          family: "unknown",
        },
      };
    }
    const fallback = fallbackErrorForStatus(response.status);
    return {
      ok: false,
      retryable: fallback.retryable,
      error: { message: combinedErrorCopy(fallback), family: fallback.family },
    };
  }

  if (!response.ok) {
    const parsedError = ErrorResponseSchema.safeParse(payload);
    if (parsedError.success) {
      const serverError = parsedError.data.error;
      const copy: DiscussionErrorCopy = {
        message: serverError.message,
        action: serverError.action,
        retryable: serverError.retryable,
        family: errorFamilyForCode(
          serverError.code as ProductErrorCode,
          serverError.retryable,
        ),
      };
      return {
        ok: false,
        retryable: serverError.retryable,
        error: {
          message: combinedErrorCopy(copy, serverError.retryAfterSeconds),
          family: copy.family,
        },
      };
    }

    const fallback = fallbackErrorForStatus(response.status);
    return {
      ok: false,
      retryable: fallback.retryable,
      error: { message: combinedErrorCopy(fallback), family: fallback.family },
    };
  }

  const parsedDiscussion = DiscussionResponseSchema.safeParse(payload);
  if (!parsedDiscussion.success) {
    return {
      ok: false,
      retryable: false,
      error: {
        message: combinedErrorCopy(malformedServerDataError()),
        family: "unknown",
      },
    };
  }

  return { ok: true, discussion: parsedDiscussion.data };
}

type HydratedSnapshot =
  | { kind: "found"; discussion: DiscussionState }
  | { kind: "missing" }
  | { kind: "error"; error: ParticipantError };

/**
 * Hydration read that distinguishes the three participant-relevant outcomes:
 * found (authoritative state), missing (the URL names a Discussion this
 * session does not own — the URL is an address, not a credential), and a
 * transient error that deserves a retry affordance.
 */
async function readHydratedDiscussion(
  discussionId: string,
  signal: AbortSignal,
): Promise<HydratedSnapshot> {
  try {
    const response = await fetch(`/api/discussions/${discussionId}`, {
      method: "GET",
      signal,
    });
    if (response.status === 404 || response.status === 401 || response.status === 403) {
      return { kind: "missing" };
    }
    const result = await readDiscussionResponse(response);
    if (!result.ok) return { kind: "error", error: result.error };
    return { kind: "found", discussion: result.discussion };
  } catch {
    return { kind: "error", error: networkError("unknown") };
  }
}

/**
 * The Discussion controller. `discussionId` is the addressable identifier of
 * the Discussion to hydrate from the authoritative persisted server state;
 * when absent the page is the New Discussion entry point (`/`).
 */
export default function DiscussionRoom({
  discussionId,
}: {
  discussionId?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [topic, setTopic] = useState("");
  const [discussion, setDiscussion] = useState<DiscussionState | null>(null);
  const [error, setError] = useState<ParticipantError | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [canRetryTurn, setCanRetryTurn] = useState(false);
  /** Whether the server reports a retryable synthesis failure to resume. */
  const [canRetrySynthesis, setCanRetrySynthesis] = useState(false);
  const [generatingSpeaker, setGeneratingSpeaker] = useState<Speaker | null>(
    null,
  );
  /** Hydration state of the addressable Discussion (hydrate mode only). */
  const [hydrateStatus, setHydrateStatus] = useState<
    "loading" | "ready" | "missing" | "error"
  >("loading");
  /** Bumped to re-run the hydration effect (the "Retry Loading" affordance). */
  const [hydrateAttempt, setHydrateAttempt] = useState(0);
  const generationControllerRef = useRef<AbortController | null>(null);
  const generationRunRef = useRef(0);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const pendingTurnRef = useRef<{
    discussionId: string;
    requestId: string;
  } | null>(null);
  const topicInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Synchronous double-click guards: the disabled attribute prevents a
  // second activation after re-render; these refs close the same-tick gap.
  const startGuardRef = useRef(false);
  const stopGuardRef = useRef(false);
  const retryGuardRef = useRef(false);

  const isCreateMode = discussionId === undefined || discussionId === null;
  const isHydrateMode = !isCreateMode;
  const isHydrating = isHydrateMode && hydrateStatus === "loading";

  // A → B navigation between addressable Discussions (same route component,
  // new discussionId prop) must never leak the previous Discussion's UI
  // state. The React-recommended way to adjust state when a prop changes is
  // during render, guarded by the previous-value check; the hydration
  // effect below then does only the ref-side reset (aborts + run identity).
  const [prevHydrateDiscussionId, setPrevHydrateDiscussionId] = useState<
    string | null
  >(discussionId ?? null);
  if (isHydrateMode && prevHydrateDiscussionId !== discussionId) {
    setPrevHydrateDiscussionId(discussionId);
    setHydrateStatus("loading");
    setCanRetryTurn(false);
    setCanRetrySynthesis(false);
    setGeneratingSpeaker(null);
    setIsGenerating(false);
    setIsStopping(false);
    setIsStarting(false);
    setDiscussion(null);
    setError(null);
  }

  useEffect(() => {
    return () => {
      generationRunRef.current += 1;
      generationControllerRef.current?.abort();
      generationControllerRef.current = null;
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
      pendingTurnRef.current = null;
    };
  }, []);

  /**
   * Ref-side reset shared by `beginFreshRun` and the hydration effect:
   * bumps the run identity and aborts every in-flight request. Only refs
   * are touched, so it is stable and safe to call from the effect.
   */
  const resetRunRefs = useCallback((): number => {
    const runId = generationRunRef.current + 1;
    generationRunRef.current = runId;
    generationControllerRef.current?.abort();
    generationControllerRef.current = null;
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    pendingTurnRef.current = null;
    return runId;
  }, []);

  /**
   * Bumps the run identity and clears every piece of lifecycle, request,
   * and error state. Used when starting a fresh Discussion, when the
   * participant explicitly resets after completion, Stop, or failure, and
   * at the start of every hydration run. Deliberately does not touch the
   * durable sessionStorage identities — those outlive the run.
   */
  function beginFreshRun(): number {
    const runId = resetRunRefs();
    setCanRetryTurn(false);
    setCanRetrySynthesis(false);
    setGeneratingSpeaker(null);
    setIsGenerating(false);
    setIsStopping(false);
    setIsStarting(false);
    setDiscussion(null);
    setError(null);
    return runId;
  }

  function startFreshDiscussion() {
    beginFreshRun();
    // A fresh Discussion is a genuinely new Start action: the previous
    // durable identities (pending Start retry and pending Turn retry) must
    // not be replayed into it.
    removeSessionStorage(PENDING_START_KEY);
    removeSessionStorage(PENDING_TURN_KEY);
    setTopic("");
    if (pathname === "/") {
      topicInputRef.current?.focus();
    } else {
      // The create page mounts after navigation; it consumes this flag to
      // restore keyboard focus to the Topic control without stealing focus
      // on a fresh visit.
      writeSessionStorage(FOCUS_TOPIC_ON_CREATE_KEY, "1");
      router.push("/");
    }
  }

  async function readPersistedDiscussion(
    discussionId: string,
    runId: number,
    signal: AbortSignal,
  ): Promise<DiscussionState | null> {
    const isStale = () =>
      generationRunRef.current !== runId || signal.aborted;
    if (isStale()) return null;

    try {
      const response = await fetch(`/api/discussions/${discussionId}`, {
        method: "GET",
        signal,
      });
      if (isStale() || !response.ok) return null;

      const payload: unknown = await response.json();
      if (isStale()) return null;

      const persistedDiscussion = DiscussionResponseSchema.safeParse(payload);
      if (isStale() || !persistedDiscussion.success) return null;

      return persistedDiscussion.data;
    } catch {
      return null;
    }
  }

  /**
   * Fire-and-forget authoritative refresh after a persisted failure. The
   * refresh has its own controller so it never rides (or blocks) the
   * generation request; a fresh run or a successful Stop aborts it.
   */
  const refreshDiscussion = useCallback(
    (discussionId: string, runId: number): void => {
      const refreshController = new AbortController();
      refreshControllerRef.current = refreshController;
      void readPersistedDiscussion(
        discussionId,
        runId,
        refreshController.signal,
      ).then((persistedDiscussion) => {
        if (refreshControllerRef.current === refreshController) {
          refreshControllerRef.current = null;
        }
        if (
          generationRunRef.current === runId &&
          !refreshController.signal.aborted &&
          persistedDiscussion
        ) {
          setDiscussion(persistedDiscussion);
          // Reconcile the synthesis retry affordance with the authoritative
          // state too: a storage outage during the synthesis phase leaves a
          // completed Discussion with a retryable/missing synthesis, and the
          // button must follow the server rather than the failed POST.
          setCanRetrySynthesis(synthesisResumable(persistedDiscussion));
        }
      });
    },
    [],
  );

  const advanceDiscussion = useCallback(
    async (
      initialDiscussion: DiscussionState,
      runId: number,
      retry = false,
    ) => {
      if (generationRunRef.current !== runId) return;

      const controller = new AbortController();
      generationControllerRef.current = controller;
      setCanRetryTurn(false);
      setCanRetrySynthesis(false);
      setIsGenerating(true);
      let current = initialDiscussion;

      try {
        while (
          (current.status === "idle" ||
            (retry &&
              current.status === "failed" &&
              current.terminalReason === null)) &&
          current.turnCount < current.turnLimit
        ) {
          const nextSpeaker = speakerForTurn(current.turnCount + 1);
          setGeneratingSpeaker(nextSpeaker);

          const pendingRequest = pendingTurnRef.current;
          const requestId =
            pendingRequest?.discussionId === current.id
              ? pendingRequest.requestId
              : crypto.randomUUID();
          pendingTurnRef.current = {
            discussionId: current.id,
            requestId,
          };
          // Durable copy: if the browser reloads while this Turn is in
          // flight, the hydrated page restores the same identity so a Retry
          // (or the server's own recovery) stays replay-safe.
          writeSessionStorage(
            PENDING_TURN_KEY,
            JSON.stringify(pendingTurnRef.current),
          );
          const requestBody = NextTurnRequestSchema.parse({ requestId });
          const response = await fetch(`/api/discussions/${current.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          });
          if (generationRunRef.current !== runId) return;

          const result = await readDiscussionResponse(response);
          if (generationRunRef.current !== runId) return;
          if (!result.ok) {
            setError(result.error);
            setCanRetryTurn(result.retryable);
            // Claim-time and terminal failures persist a new server state;
            // refresh it so status and controls follow the server. Wait-family
            // and Topic errors leave the Discussion unchanged, so no refresh
            // is needed. Ambiguous network failures are recovered by Retry
            // with the same request identity (replay-safe).
            if (
              result.error.family !== "wait" &&
              result.error.family !== "topic"
            ) {
              refreshDiscussion(current.id, runId);
            }
            if (!result.retryable) {
              pendingTurnRef.current = null;
              removeSessionStorage(PENDING_TURN_KEY);
            }
            return;
          }

          pendingTurnRef.current = null;
          removeSessionStorage(PENDING_TURN_KEY);
          current = result.discussion;
          setDiscussion(current);
          setError(null);
          // The Turn request identity's job is done once the server
          // confirms the outcome. A retryable or missing synthesis is
          // resumed through its own server-owned seam (the synthesis
          // endpoint), never by replaying the final-Turn request.
          setCanRetrySynthesis(synthesisResumable(current));
        }
      } catch {
        if (generationRunRef.current !== runId || controller.signal.aborted) {
          return;
        }
        setError(networkError("retry"));
        setCanRetryTurn(true);
      } finally {
        if (generationRunRef.current === runId) {
          generationControllerRef.current = null;
          setGeneratingSpeaker(null);
          setIsGenerating(false);
          retryGuardRef.current = false;
        }
      }
    },
    [refreshDiscussion],
  );

  function retryTurn() {
    if (
      !discussion ||
      !pendingTurnRef.current ||
      pendingTurnRef.current.discussionId !== discussion.id ||
      isGenerating ||
      isStopping ||
      retryGuardRef.current
    ) {
      return;
    }

    retryGuardRef.current = true;
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    setError(null);
    if (discussion.status === "completed") {
      // The debate already committed (a mid-debate retry cannot leave a
      // completed Discussion): the pending identity is the final-Turn
      // request, so the server routes the replay to the synthesis resume.
      // Without this, a retryable error after the final Turn committed
      // (e.g. a storage outage during the synthesis phase) would leave a
      // dead Retry button: `advanceDiscussion` only re-POSTs idle/failed
      // Discussions.
      void resumeSynthesis(discussion, generationRunRef.current);
      return;
    }
    void advanceDiscussion(discussion, generationRunRef.current, true);
  }

  /**
   * Resumes the completion synthesis through the server-owned retry seam
   * (`POST /api/discussions/:id/synthesis`). The server derives everything
   * from durable state — ownership from the signed session, the resource
   * from the Discussion id, and the retry decision from the persisted
   * `synthesis` sub-state — so no Turn request identity is involved and
   * the retry works from a totally fresh tab with only the canonical URL
   * and the ownership cookie. A new HTTP request never creates a second
   * logical synthesis: the server's claim is idempotent and at most one
   * attempt ever commits.
   */
  const resumeSynthesis = useCallback(
    async (initialDiscussion: DiscussionState, runId: number) => {
      if (generationRunRef.current !== runId) return;

      const controller = new AbortController();
      generationControllerRef.current = controller;
      setCanRetrySynthesis(false);
      setIsGenerating(true);

      try {
        const response = await fetch(
          `/api/discussions/${initialDiscussion.id}/synthesis`,
          {
            method: "POST",
            signal: controller.signal,
          },
        );
        if (generationRunRef.current !== runId) return;

        const result = await readDiscussionResponse(response);
        if (generationRunRef.current !== runId) return;
        if (!result.ok) {
          // Network, quota, or state error: the persisted synthesis state
          // is authoritative, so the retry affordance follows it.
          setError(result.error);
          setCanRetrySynthesis(result.retryable);
          return;
        }

        const current = result.discussion;
        setDiscussion(current);
        setError(null);
        setCanRetrySynthesis(synthesisResumable(current));
      } catch {
        if (generationRunRef.current === runId) {
          setError(networkError("retry"));
          setCanRetrySynthesis(true);
        }
      } finally {
        if (generationRunRef.current === runId) {
          generationControllerRef.current = null;
          setIsGenerating(false);
          retryGuardRef.current = false;
        }
      }
    },
    [],
  );

  function retrySynthesis() {
    if (
      !discussion ||
      !synthesisResumable(discussion) ||
      isGenerating ||
      isStopping ||
      retryGuardRef.current
    ) {
      return;
    }

    retryGuardRef.current = true;
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    setError(null);
    void resumeSynthesis(discussion, generationRunRef.current);
  }

  /**
   * Reconciles hydrated server state into the controller: the Discussion
   * renders as-is for terminal states, auto-continues an idle Discussion,
   * and restores Retry for a retryable failure whose pending request
   * identity survived the reload.
   */
  const reconcileHydrated = useCallback(
    (persisted: DiscussionState, runId: number): void => {
      // A confirmed, successfully hydrated Discussion resolves the pending
      // Start identity that created it (or would have replayed it): after
      // this point the participant has seen the Discussion, so a later
      // explicit Start for the same Topic is a new logical action, not a
      // retry. A pending identity whose Topic differs belongs to an
      // unrelated Start and is left intact.
      const pendingStart = readPendingStart();
      if (pendingStart && pendingStart.topic === persisted.topic) {
        removeSessionStorage(PENDING_START_KEY);
      }

      setDiscussion(persisted);
      setError(null);

      if (persisted.status === "idle") {
        setCanRetryTurn(false);
        setCanRetrySynthesis(false);
        pendingTurnRef.current = null;
        void advanceDiscussion(persisted, runId);
      } else if (
        persisted.status === "failed" &&
        persisted.terminalReason === null
      ) {
        const pendingTurn = readPendingTurn();
        if (pendingTurn && pendingTurn.discussionId === persisted.id) {
          pendingTurnRef.current = pendingTurn;
          setCanRetryTurn(true);
          setCanRetrySynthesis(false);
        } else {
          pendingTurnRef.current = null;
          setCanRetryTurn(false);
          setCanRetrySynthesis(false);
        }
      } else if (persisted.status === "completed" && synthesisResumable(persisted)) {
        // The debate is durable; only the synthesis needs a resume (missing
        // or retryable-failed). The retry is driven purely by persisted
        // state: the server derives ownership from the session and the
        // resource from the Discussion id, so no browser-held Turn request
        // identity is required and a fresh tab with only the canonical URL
        // works.
        pendingTurnRef.current = null;
        setCanRetryTurn(false);
        setCanRetrySynthesis(true);
      } else {
        // completed / stopped / failed-terminal: render as-is, no Turn
        // continuation and no Retry.
        pendingTurnRef.current = null;
        removeSessionStorage(PENDING_TURN_KEY);
        setCanRetryTurn(false);
        setCanRetrySynthesis(false);
      }
    },
    [advanceDiscussion],
  );

  function retryHydration() {
    setHydrateStatus("loading");
    setError(null);
    setHydrateAttempt((attempt) => attempt + 1);
  }

  // Hydration of the addressable Discussion. Runs when the component mounts
  // in hydrate mode and when the discussionId changes (A → B navigation).
  // The flow never starts a Turn while the server reports generating, and a
  // runId change (Stop, fresh run, unmount) aborts it immediately.
  useEffect(() => {
    if (discussionId === undefined || discussionId === null) return;

    let cancelled = false;
    const controller = new AbortController();
    // Ref-side reset only: UI state was already cleared during render when
    // the discussionId changed. Aborting here must not call setState.
    const runId = resetRunRefs();

    const stale = () => cancelled || generationRunRef.current !== runId;

    void (async () => {
      // URL is an address, not a credential: only well-formed identifiers
      // are even worth asking the server about.
      if (!DiscussionIdentifierSchema.safeParse(discussionId).success) {
        setHydrateStatus("missing");
        return;
      }

      const initial = await readHydratedDiscussion(
        discussionId,
        controller.signal,
      );
      if (stale()) return;
      if (initial.kind === "missing") {
        setHydrateStatus("missing");
        return;
      }
      if (initial.kind === "error") {
        setError(initial.error);
        setHydrateStatus("error");
        return;
      }

      let current = initial.discussion;
      setDiscussion(current);

      // Polling covers both an in-flight Turn and the server-owned synthesis
      // running after the final Turn commits: the page only observes.
      const observing = (state: DiscussionState) =>
        state.status === "generating" ||
        (state.status === "completed" &&
          state.synthesis?.status === "generating");
      if (observing(current)) {
        // The server owns the in-flight generation; the page only observes
        // it. Polling never re-claims: the moment the state resolves it is
        // reconciled, and a Stop or fresh run aborts the poll.
        let attempts = 0;
        while (attempts < HYDRATION_POLL_LIMIT) {
          await delay(HYDRATION_POLL_INTERVAL_MS, controller.signal);
          if (stale()) return;
          const snapshot = await readHydratedDiscussion(
            discussionId,
            controller.signal,
          );
          if (stale()) return;
          if (snapshot.kind === "missing") {
            setHydrateStatus("missing");
            return;
          }
          if (snapshot.kind === "found") {
            current = snapshot.discussion;
            setDiscussion(current);
            if (!observing(current)) break;
          }
          attempts += 1;
        }
        if (stale()) return;
        if (observing(current)) {
          // Poll cap reached while the server is still generating: stop
          // observing and hand control back. The persisted state is
          // authoritative; a reload resumes hydration.
          setHydrateStatus("ready");
          setError({
            message:
              "This Discussion is still generating. Reload this page to see the latest Turns.",
            family: "unknown",
          });
          return;
        }
      }

      setHydrateStatus("ready");
      reconcileHydrated(current, runId);
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [discussionId, hydrateAttempt, resetRunRefs, reconcileHydrated]);

  // Create-mode mount work: restore keyboard focus after an explicit
  // "Start a New Discussion" navigation, and recover a Start whose response
  // was lost (ambiguous outcome) by retrying the durable identity — an
  // exact retry replays the same Discussion instead of creating an orphan.
  useEffect(() => {
    if (!isCreateMode) return;

    if (readSessionStorage(FOCUS_TOPIC_ON_CREATE_KEY)) {
      removeSessionStorage(FOCUS_TOPIC_ON_CREATE_KEY);
      topicInputRef.current?.focus();
    }

    const pending = readPendingStart();
    if (!pending || startGuardRef.current) return;

    let cancelled = false;
    startGuardRef.current = true;
    setIsStarting(true);
    setTopic(pending.topic);

    void (async () => {
      try {
        const response = await fetch("/api/discussions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            topic: pending.topic,
            creationRequestId: pending.requestId,
          }),
        });
        if (cancelled) return;
        const result = await readDiscussionResponse(response);
        if (cancelled) return;
        if (!result.ok) {
          setError(result.error);
          if (result.error.family === "topic") {
            removeSessionStorage(PENDING_START_KEY);
            topicInputRef.current?.focus();
          }
          return;
        }
        // Success is confirmed: the identity's job is done. The Discussion
        // is now owned by its own route, which hydrates the authoritative
        // state (and resolves any leftover pending identity).
        removeSessionStorage(PENDING_START_KEY);
        setDiscussion(result.discussion);
        router.push(`/discussions/${result.discussion.id}`);
      } catch {
        if (!cancelled) {
          setError(networkError("unknown"));
        }
      } finally {
        if (!cancelled) {
          setIsStarting(false);
          startGuardRef.current = false;
        }
      }
    })();

    return () => {
      cancelled = true;
      // A React StrictMode double-invocation (or any remount) must not
      // strand the recovery: the first invocation's cleanup cancels its
      // in-flight retry, and the guard must be released so the next mount
      // can re-attempt it. The retry is idempotent (same creation identity
      // replays the committed Discussion), so a duplicate in-flight retry
      // is harmless.
      startGuardRef.current = false;
    };
  }, [isCreateMode, router]);

  async function startDiscussion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (startGuardRef.current) return;

    const parsedTopic = DiscussionTopicSchema.safeParse(topic);
    if (!parsedTopic.success) {
      setError({ message: topicError(topic), family: "topic" });
      topicInputRef.current?.focus();
      return;
    }

    startGuardRef.current = true;
    const runId = beginFreshRun();
    setIsStarting(true);
    try {
      // Idempotent Start: a stable identity is persisted for one logical
      // Start operation. An exact retry (same Topic) reuses it and replays
      // the same Discussion; a different Topic gets a fresh identity.
      const requestId = resolveStartIdentity(parsedTopic.data);
      const response = await fetch("/api/discussions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: parsedTopic.data,
          creationRequestId: requestId,
        }),
      });
      if (generationRunRef.current !== runId) return;

      const result = await readDiscussionResponse(response);
      if (generationRunRef.current !== runId) return;
      if (!result.ok) {
        setError(result.error);
        if (result.error.family === "topic") {
          // The identity is burned (or the Topic is rejected); the next
          // Start resolves a fresh one.
          removeSessionStorage(PENDING_START_KEY);
          topicInputRef.current?.focus();
        }
        return;
      }

      // The Discussion is created server-side. Deliberately do NOT start
      // advancing Turns here: this page is about to be replaced by the
      // Discussion's own route, and a Turn started here would be aborted by
      // the unmount, persisting a spurious disconnect-stop on the server.
      // The hydrated route page owns the continuation. The pending identity
      // stays until that hydration confirms the Discussion, so a lost
      // response (never navigated) remains replay-safe.
      router.push(`/discussions/${result.discussion.id}`);
    } catch {
      if (generationRunRef.current === runId) {
        setError(networkError("unknown"));
      }
    } finally {
      if (generationRunRef.current === runId) {
        setIsStarting(false);
        startGuardRef.current = false;
      }
    }
  }

  /**
   * Resolves the stable Start identity for a Topic: reuses the pending
   * identity for an exact retry (same Topic), otherwise mints and persists
   * a fresh one. The Topic participates in the identity so a different
   * Topic can never silently replay an unrelated Discussion.
   */
  function resolveStartIdentity(topicValue: string): string {
    const pending = readPendingStart();
    if (pending && pending.topic === topicValue) {
      return pending.requestId;
    }
    const requestId = crypto.randomUUID();
    writeSessionStorage(
      PENDING_START_KEY,
      JSON.stringify({ requestId, topic: topicValue } satisfies PendingStartIdentity),
    );
    return requestId;
  }

  async function stopDiscussion() {
    if (!discussion) return;
    const serverGenerating =
      isGenerating || discussion.status === "generating";
    if (!serverGenerating || isStopping || stopGuardRef.current) {
      return;
    }

    const activeRunId = generationRunRef.current;
    const turnController = generationControllerRef.current;
    stopGuardRef.current = true;
    setIsStopping(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/discussions/${discussion.id}/stop`,
        { method: "POST" },
      );
      if (generationRunRef.current !== activeRunId) return;

      const result = await readDiscussionResponse(response);
      if (generationRunRef.current !== activeRunId) return;

      if (!result.ok) {
        setError(result.error);
        setCanRetryTurn(false);
        // Stop failed while generation may still be running; refresh the
        // authoritative state so status and controls match the server.
        refreshDiscussion(discussion.id, activeRunId);
        return;
      }
      if (result.discussion.status !== "stopped") {
        setError({
          message: combinedErrorCopy(malformedServerDataError()),
          family: "unknown",
        });
        setCanRetryTurn(false);
        refreshDiscussion(discussion.id, activeRunId);
        return;
      }

      generationRunRef.current = activeRunId + 1;
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
      setDiscussion(result.discussion);
      pendingTurnRef.current = null;
      removeSessionStorage(PENDING_TURN_KEY);
      setCanRetryTurn(false);
      setError(null);
      setGeneratingSpeaker(null);
      setIsGenerating(false);
      setIsStopping(false);
      stopGuardRef.current = false;
      turnController?.abort();
      if (generationControllerRef.current === turnController) {
        generationControllerRef.current = null;
      }
    } catch {
      if (generationRunRef.current === activeRunId) {
        setError(networkError("unknown"));
      }
    } finally {
      if (generationRunRef.current === activeRunId) {
        setIsStopping(false);
        stopGuardRef.current = false;
      }
    }
  }

  const phase = derivePhase(discussion, {
    isStarting,
    isHydrating,
    isStopping,
    isGenerating,
    generatingSpeaker,
    errorFamily: error?.family ?? null,
  });
  const stopVisible = phase.kind === "generating" || phase.kind === "stopping";
  const retryVisible = canRetryTurn && !isGenerating && !isStopping;
  const newDiscussionVisible =
    discussion !== null &&
    (phase.kind === "completed" ||
      phase.kind === "stopped" ||
      phase.kind === "failed" ||
      error?.family === "terminal" ||
      error?.family === "unknown");
  const topicInvalid = error?.family === "topic";
  const showLifecycleStatus =
    isCreateMode || discussion !== null || hydrateStatus === "loading";

  return (
    <main className="page-shell flex min-h-dvh flex-col gap-6 px-4 py-6 sm:gap-8 sm:px-8 sm:py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Agent Discussion Room
        </h1>
        <p className="mt-2 text-muted">
          Choose a permitted Topic, then explicitly start a bounded Discussion
          between a Supporter and an Opponent.
        </p>
      </header>

      {isCreateMode ? (
        <form onSubmit={startDiscussion} className="flex flex-col gap-3">
          <label htmlFor="discussion-topic" className="font-semibold">
            Discussion Topic
          </label>
          <textarea
            id="discussion-topic"
            name="topic"
            ref={topicInputRef}
            value={topic}
            maxLength={TOPIC_MAX_LENGTH + 1}
            rows={3}
            aria-describedby="topic-help"
            aria-invalid={topicInvalid || undefined}
            onChange={(event) => setTopic(event.target.value)}
            className="rounded-lg border border-border bg-surface p-3"
          />
          <p id="topic-help" className="text-sm text-muted">
            Enter plain text, up to {TOPIC_MAX_LENGTH} characters.
          </p>
          <button
            type="submit"
            disabled={isStarting || isGenerating || isStopping}
            className="control control-block rounded-lg bg-accent px-5 py-2 font-semibold text-accent-foreground disabled:opacity-60"
          >
            {isStarting ? "Starting Discussion…" : "Start Discussion"}
          </button>
        </form>
      ) : null}

      <p role="alert" aria-live="polite" className="min-h-6 text-error">
        {error?.message}
      </p>

      {isHydrateMode && hydrateStatus === "missing" ? (
        <section
          aria-labelledby="missing-discussion-heading"
          className="flex flex-col gap-4"
        >
          <h2 id="missing-discussion-heading" className="text-xl font-semibold sm:text-2xl">
            Discussion unavailable
          </h2>
          <p className="text-muted">
            This Discussion is not available in this browser session. A
            Discussion belongs to the anonymous session that started it — the
            URL alone does not grant access. Start a new Discussion in this
            session, or return to the session that created it.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <button
              type="button"
              onClick={startFreshDiscussion}
              className="control control-block rounded-lg border border-border bg-surface px-5 py-2 font-semibold text-foreground"
            >
              Start a New Discussion
            </button>
          </div>
        </section>
      ) : null}

      {isHydrateMode && hydrateStatus === "error" ? (
        <section
          aria-labelledby="hydration-error-heading"
          className="flex flex-col gap-4"
        >
          <h2 id="hydration-error-heading" className="text-xl font-semibold sm:text-2xl">
            Could not load this Discussion
          </h2>
          <p className="text-muted">
            {error?.message ??
              "The server could not be reached. Check your connection and try again."}
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <button
              type="button"
              onClick={retryHydration}
              className="control control-block rounded-lg bg-accent px-5 py-2 font-semibold text-accent-foreground"
            >
              Retry Loading
            </button>
            <button
              type="button"
              onClick={startFreshDiscussion}
              className="control control-block rounded-lg border border-border bg-surface px-5 py-2 font-semibold text-foreground"
            >
              Start a New Discussion
            </button>
          </div>
        </section>
      ) : null}

      {showLifecycleStatus ? <LifecycleStatus phase={phase} /> : null}

      {discussion ? (
        <section
          aria-labelledby="active-topic"
          aria-busy={isGenerating || isStopping}
          className="flex flex-col gap-4"
        >
          <div>
            <p className="text-sm font-semibold tracking-wide text-muted uppercase">
              Active Topic
            </p>
            <h2
              id="active-topic"
              className="reflow text-xl font-semibold sm:text-2xl"
            >
              {discussion.topic}
            </h2>
          </div>
          <p
            aria-label="Turn progress"
            className="font-medium text-muted tabular-nums"
          >
            {discussion.turnCount} / {discussion.turnLimit} Turns
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {stopVisible ? (
              <button
                type="button"
                onClick={() => void stopDiscussion()}
                disabled={isStopping}
                className="control control-block rounded-lg bg-danger px-5 py-2 font-semibold text-danger-foreground disabled:opacity-60"
              >
                Stop Discussion
              </button>
            ) : null}
            {retryVisible ? (
              <button
                type="button"
                onClick={retryTurn}
                disabled={isStopping}
                className="control control-block rounded-lg bg-accent px-5 py-2 font-semibold text-accent-foreground disabled:opacity-60"
              >
                Retry Turn
              </button>
            ) : null}
            {newDiscussionVisible ? (
              <button
                type="button"
                onClick={startFreshDiscussion}
                className="control control-block rounded-lg border border-border bg-surface px-5 py-2 font-semibold text-foreground"
              >
                Start a New Discussion
              </button>
            ) : null}
          </div>
          <Transcript messages={discussion.transcript} />
          {discussion.status === "completed" &&
          (discussion.synthesis !== undefined || canRetrySynthesis) ? (
            <DiscussionSynthesis
              synthesis={discussion.synthesis ?? null}
              retrying={isGenerating}
              canRetry={canRetrySynthesis}
              onRetry={retrySynthesis}
            />
          ) : null}
        </section>
      ) : null}
    </main>
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      resolve();
    };
    function cleanup() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
    signal.addEventListener("abort", onAbort);
  });
}
