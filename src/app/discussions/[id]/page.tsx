import DiscussionRoom from "@/app/discussion-room";

/**
 * Addressable, resumable Discussion route. The canonical URL for a
 * Discussion is `/discussions/:discussionId`; the Discussion controller
 * hydrates the authoritative persisted server state on load, so a reload or
 * a direct navigation resumes the Discussion without duplicating Turns.
 * Ownership stays with the anonymous session that created the Discussion —
 * the URL is an address, not a credential.
 */
export default async function DiscussionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DiscussionRoom discussionId={id} />;
}
