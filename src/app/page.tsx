import DiscussionRoom from "./discussion-room";

/**
 * New Discussion entry point. The Discussion controller renders in create
 * mode; after a successful Start it navigates to the Discussion's own
 * addressable route (`/discussions/:id`), which owns the continuation.
 */
export default function Home() {
  return <DiscussionRoom />;
}
