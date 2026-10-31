/**
 * @param {Record<string, any>} set
 */
export function migrateQuickReplySet(set) {
    if (set.version === 2) return;
    set.version = 2;
    set.disableSend = set.quickActionEnabled ?? false;
    set.placeBeforeInput = set.placeBeforeInputEnabled ?? false;
    set.injectInput = set.AutoInputInject ?? false;
    set.qrList = (set.quickReplySlots ?? []).map((slot, idx) => {
        const qr = {};
        qr.id = idx + 1;
        qr.label = slot.label ?? '';
        qr.title = slot.title ?? '';
        qr.message = slot.mes ?? '';
        qr.isHidden = slot.hidden ?? false;
        qr.executeOnStartup = slot.autoExecute_appStartup ?? false;
        qr.executeOnUser = slot.autoExecute_userMessage ?? false;
        qr.executeOnAi = slot.autoExecute_botMessage ?? false;
        qr.executeOnChatChange = slot.autoExecute_chatLoad ?? false;
        qr.executeOnGroupMemberDraft = slot.autoExecute_groupMemberDraft ?? false;
        qr.executeOnNewChat = slot.autoExecute_newChat ?? false;
        qr.executeBeforeGeneration = slot.autoExecute_beforeGeneration ?? false;
        qr.automationId = slot.automationId ?? '';
        qr.contextList = (slot.contextMenu ?? []).map(it => ({
            set: it.preset,
            isChained: it.chain,
        }));
        return qr;
    });
}
