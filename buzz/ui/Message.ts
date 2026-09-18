// Message — single chat bubble with avatar, reactions, mentions, Linear unfurl
// Rendered inside RoomView thread list. See src/console/buzz.ts avatarColor/initials/linkify.

export interface ChatMessageProps {
  author: string;
  createdAt: number;
  content: string;
  isReviewCard?: boolean;
  requestId?: string | null;
}
