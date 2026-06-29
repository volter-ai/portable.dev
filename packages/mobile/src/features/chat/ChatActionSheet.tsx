/**
 * ChatActionSheet — the SHARED long-press menu for a chat card (Pin / Save / Archive
 * / Delete) + its delete-confirm modal, so the long-press behavior is IDENTICAL
 * wherever a chat card appears:
 *   - the `/chats` directory (`ChatDirectoryScreen`) — drives the actions through its
 *     own optimistic `useChatDirectory` moves;
 *   - the home "Continue chats" preview AND the repo Overview "Continue chats" preview
 *     (both via `HomeChatsSection`) — drive them through {@link useChatActionSheet}
 *     (standalone mutations + a cache invalidation).
 * Both paths render the SAME `ChatActionSheet`, so the menu never drifts between lists.
 *
 * Safe area: the sheet is a bottom slide-up `Modal`, which (under edge-to-edge) draws
 * UNDER the Android nav bar — so it pads by the window bottom inset
 * ({@link useWindowInsets}, the Modal convention) or the actions sit behind the
 * back/home buttons.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import type { ChatListItem } from '@vgit2/shared/types';

import { useArchiveChat, useDeleteChat, useSaveChat, useSetChatPin } from '../api/hooks';
import { queryKeys } from '../api/keys';
import { useWindowInsets } from '../shell/windowInsets';
import { Icon, type IconName, useAppTheme } from '../../theme';

export interface ChatActionSheetProps {
  /** The chat the menu acts on (null = closed). */
  chat: ChatListItem | null;
  onClose: () => void;
  onPin: (id: string, pinned: boolean) => void;
  onSave: (id: string, save: boolean) => void;
  onArchive: (id: string, archive: boolean) => void;
  onDelete: (chat: ChatListItem) => void;
}

/**
 * The slide-up action sheet. Labels are context-aware off the chat's
 * `pinned`/`saved`/`archived` flags (Unpin / Unsave / Unarchive). Pin is orthogonal;
 * Save and Archive are mutually-exclusive buckets (the backend clears the other).
 */
export function ChatActionSheet({
  chat,
  onClose,
  onPin,
  onSave,
  onArchive,
  onDelete,
}: ChatActionSheetProps) {
  const { theme } = useAppTheme();
  const insets = useWindowInsets();
  if (!chat) return null;

  const pinned = !!chat.pinned;
  const saved = !!chat.saved;
  const isArchived = !!chat.archived;

  const actions: {
    key: string;
    testID: string;
    icon: IconName;
    label: string;
    onPress: () => void;
  }[] = [
    {
      key: 'pin',
      testID: `chat-action-pin-${chat.id}`,
      icon: 'pin',
      label: pinned ? 'Unpin' : 'Pin',
      onPress: () => onPin(chat.id, !pinned),
    },
    {
      key: 'save',
      testID: `chat-action-save-${chat.id}`,
      icon: 'bookmark',
      label: saved ? 'Unsave' : 'Save',
      onPress: () => onSave(chat.id, !saved),
    },
    {
      key: 'archive',
      testID: `chat-action-archive-${chat.id}`,
      icon: isArchived ? 'refresh' : 'archive',
      label: isArchived ? 'Unarchive' : 'Archive',
      onPress: () => onArchive(chat.id, !isArchived),
    },
  ];

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} testID="chat-action-backdrop">
        {/* Inner press is a no-op so tapping the sheet body doesn't dismiss it. */}
        <Pressable
          style={[
            styles.sheet,
            // Lift the actions clear of the Android nav bar (edge-to-edge Modal).
            { paddingBottom: Math.max(insets.bottom, 12) + 16 },
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
          ]}
          testID="chat-action-sheet"
          onPress={() => {}}
        >
          {actions.map((a) => (
            <Pressable
              key={a.key}
              testID={a.testID}
              accessibilityRole="button"
              accessibilityLabel={a.label}
              style={styles.sheetRow}
              onPress={a.onPress}
            >
              <Icon name={a.icon} size={18} color={theme.colors.text} />
              <Text style={[styles.sheetLabel, { color: theme.colors.text }]}>{a.label}</Text>
            </Pressable>
          ))}
          <Pressable
            testID={`chat-action-delete-${chat.id}`}
            accessibilityRole="button"
            accessibilityLabel="Delete chat"
            style={styles.sheetRow}
            onPress={() => onDelete(chat)}
          >
            <Icon name="trash" size={18} color={theme.colors.danger} />
            <Text style={[styles.sheetLabel, { color: theme.colors.danger }]}>Delete</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export interface ChatDeleteConfirmModalProps {
  /** The chat queued for deletion (null = closed). */
  chat: ChatListItem | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Centered "Delete chat?" confirm (the StorageScreen precedent — NOT full-screen). */
export function ChatDeleteConfirmModal({ chat, onCancel, onConfirm }: ChatDeleteConfirmModalProps) {
  const { theme } = useAppTheme();
  return (
    <Modal visible={chat !== null} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <View
          style={[
            styles.modalCard,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
          ]}
          testID="chat-delete-confirm"
        >
          <Text style={[styles.modalTitle, { color: theme.colors.text }]}>Delete chat?</Text>
          <Text style={[styles.modalBody, { color: theme.colors.textSecondary }]}>
            This removes the conversation from your list. This can’t be undone.
          </Text>
          <View style={styles.modalActions}>
            <Pressable
              testID="chat-delete-cancel"
              onPress={onCancel}
              style={[styles.modalButton, { borderColor: theme.colors.border }]}
            >
              <Text style={[styles.modalButtonText, { color: theme.colors.textSecondary }]}>
                Cancel
              </Text>
            </Pressable>
            <Pressable
              testID="chat-delete-submit"
              onPress={onConfirm}
              style={[styles.modalButton, { backgroundColor: theme.colors.danger }]}
            >
              <Text style={[styles.modalButtonText, { color: '#fff', fontWeight: '700' }]}>
                Delete
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * Drop-in long-press handler for any chat-preview list that does NOT own a
 * `useChatDirectory` (the home + repo Overview previews). Returns `open(chat)` to wire
 * to a card's long-press and `element` to render once in the tree. Pin/Save/Archive
 * go through the standalone mutation hooks; on success it invalidates every chat
 * surface (the directory's per-category infinite queries + the previews' `['chats']`
 * query) so all lists reflect the change.
 */
export function useChatActionSheet(): { open: (chat: ChatListItem) => void; element: ReactNode } {
  const qc = useQueryClient();
  const archiveMutation = useArchiveChat();
  const saveMutation = useSaveChat();
  const pinMutation = useSetChatPin();
  const deleteMutation = useDeleteChat();
  const [actionChat, setActionChat] = useState<ChatListItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ChatListItem | null>(null);

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['chat-directory'] }); // all categories (prefix)
    void qc.invalidateQueries({ queryKey: queryKeys.chats() }); // home + repo previews
  }, [qc]);

  const open = useCallback((chat: ChatListItem) => setActionChat(chat), []);

  const element = (
    <>
      <ChatActionSheet
        chat={actionChat}
        onClose={() => setActionChat(null)}
        onPin={(id, pinned) => {
          pinMutation.mutate({ chatId: id, pinned }, { onSuccess: refresh });
          setActionChat(null);
        }}
        onSave={(id, save) => {
          saveMutation.mutate({ chatId: id, saved: save }, { onSuccess: refresh });
          setActionChat(null);
        }}
        onArchive={(id, archive) => {
          archiveMutation.mutate({ chatId: id, archived: archive }, { onSuccess: refresh });
          setActionChat(null);
        }}
        onDelete={(chat) => {
          setActionChat(null);
          setPendingDelete(chat);
        }}
      />
      <ChatDeleteConfirmModal
        chat={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            deleteMutation.mutate({ chatId: pendingDelete.id }, { onSuccess: refresh });
          }
          setPendingDelete(null);
        }}
      />
    </>
  );

  return { open, element };
}

const styles = StyleSheet.create({
  // Long-press action sheet (slide-up from the bottom).
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 22,
  },
  sheetLabel: { fontSize: 16, fontWeight: '500' },
  // Centered delete-confirm card.
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 20,
    gap: 8,
  },
  modalTitle: { fontSize: 16, fontWeight: '700' },
  modalBody: { fontSize: 13 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 12 },
  modalButton: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    minWidth: 80,
    alignItems: 'center',
  },
  modalButtonText: { fontSize: 13 },
});
