import { SlashCommandParser } from '../SlashCommandParser.js';
import { SlashCommand } from '../SlashCommand.js';
import { findGroupMemberId, getGroupMembers, groupsStore, is_group_generating, saveGroupField, selected_group } from '../../group-chats.js';
import { t } from '../../i18n.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../SlashCommandArgument.js';
import { commonEnumProviders } from '../SlashCommandCommonEnumsProvider.js';
import { SlashCommandEnumValue } from '../SlashCommandEnumValue.js';
import { findChar } from '../../utils.js';

/**
 * Copium for running group actions when the member is offscreen.
 * @param {string} avatar - character avatar
 * @param {string} action - one of 'enable', 'disable', 'up', 'down', 'view', 'remove'
 * @returns {void}
 */
function performGroupMemberAction(avatar, action) {
    const memberSelector = `.group_member[data-avatar="${CSS.escape(avatar)}"]`;
    // Do not optimize. Paginator gets recreated on every action
    const paginationSelector = '#rm_group_members_pagination';
    const pageSizeSelector = '#rm_group_members_pagination select';
    let wasOffscreen = false;
    let paginationValue = null;
    let pageValue = null;

    if ($(memberSelector).length === 0) {
        wasOffscreen = true;
        paginationValue = Number($(pageSizeSelector).val());
        pageValue = $(paginationSelector).pagination('getCurrentPageNum');
        $(pageSizeSelector).val($(pageSizeSelector).find('option').last().val()).trigger('change');
    }

    $(memberSelector).find(`[data-action="${action}"]`).trigger('click');

    if (wasOffscreen) {
        $(pageSizeSelector).val(paginationValue).trigger('change');
        if ($(paginationSelector).length) {
            $(paginationSelector).pagination('go', pageValue);
        }
    }
}

async function disableGroupMemberCallback(_, arg) {
    if (!selected_group) {
        toastr.warning(t`Cannot run /member-disable command outside of a group chat.`);
        return '';
    }

    const avatar = findGroupMemberId(arg);

    if (avatar === undefined) {
        console.warn(`WARN: No group member found for argument ${arg}`);
        return '';
    }

    performGroupMemberAction(avatar, 'disable');
    return '';
}

async function enableGroupMemberCallback(_, arg) {
    if (!selected_group) {
        toastr.warning(t`Cannot run /member-enable command outside of a group chat.`);
        return '';
    }

    const avatar = findGroupMemberId(arg);

    if (avatar === undefined) {
        console.warn(`WARN: No group member found for argument ${arg}`);
        return '';
    }

    performGroupMemberAction(avatar, 'enable');
    return '';
}

async function moveGroupMemberUpCallback(_, arg) {
    if (!selected_group) {
        toastr.warning(t`Cannot run /member-up command outside of a group chat.`);
        return '';
    }

    const avatar = findGroupMemberId(arg);

    if (avatar === undefined) {
        console.warn(`WARN: No group member found for argument ${arg}`);
        return '';
    }

    performGroupMemberAction(avatar, 'up');
    return '';
}

async function moveGroupMemberDownCallback(_, arg) {
    if (!selected_group) {
        toastr.warning(t`Cannot run /member-down command outside of a group chat.`);
        return '';
    }

    const avatar = findGroupMemberId(arg);

    if (avatar === undefined) {
        console.warn(`WARN: No group member found for argument ${arg}`);
        return '';
    }

    performGroupMemberAction(avatar, 'down');
    return '';
}

async function peekCallback(_, arg) {
    if (!selected_group) {
        toastr.warning(t`Cannot run /member-peek command outside of a group chat.`);
        return '';
    }

    if (is_group_generating) {
        toastr.warning(t`Cannot run /member-peek command while the group reply is generating.`);
        return '';
    }

    const avatar = findGroupMemberId(arg);

    if (avatar === undefined) {
        console.warn(`WARN: No group member found for argument ${arg}`);
        return '';
    }

    performGroupMemberAction(avatar, 'view');
    return '';
}

async function countGroupMemberCallback() {
    if (!selected_group) {
        toastr.warning(t`Cannot run /member-count command outside of a group chat.`);
        return '';
    }

    return String((await getGroupMembers(selected_group)).resolved.length);
}

async function removeGroupMemberCallback(_, arg) {
    if (!selected_group) {
        toastr.warning(t`Cannot run /member-remove command outside of a group chat.`);
        return '';
    }

    const avatar = findGroupMemberId(arg);

    if (avatar === undefined) {
        console.warn(`WARN: No group member found for argument ${arg}`);
        return '';
    }

    performGroupMemberAction(avatar, 'remove');
    return '';
}

async function addGroupMemberCallback(_, name) {
    if (!selected_group) {
        toastr.warning(t`Cannot run /memberadd command outside of a group chat.`);
        return '';
    }

    if (!name) {
        console.warn('WARN: No argument provided for /memberadd command');
        return '';
    }

    const character = findChar({ name: name, preferCurrentChar: false });
    if (!character) {
        console.warn(`WARN: No character found for argument ${name}`);
        return '';
    }

    const group = groupsStore.get(selected_group);

    if (!group || !Array.isArray(group.members)) {
        console.warn(`WARN: No group found for ID ${selected_group}`);
        return '';
    }

    const avatar = character.avatar;

    if (group.members.includes(avatar)) {
        toastr.warning(t`${character.name} is already a member of this group.`);
        return '';
    }

    group.members.push(avatar);
    // group.members is already mutated above; this just notifies groupsStore subscribers to reprint.
    groupsStore.update(selected_group, { members: group.members });
    // Adding a member is a single discrete command, not a continuous edit - save immediately, same as
    // modifyGroupMember()'s own member-list add/remove (group-chats.js). The previous saveGroupChat()
    // call here never actually persisted this: /group/save only writes chat messages/metadata, never
    // group.members, so this command silently relied on in-memory state alone until a real reload wiped it.
    await saveGroupField(selected_group, { members: group.members }, true, false);
    return character.name;
}

export function registerGroupCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'member-get',
        aliases: ['getmember', 'memberget'],
        callback: (async ({ field = 'name' }, arg) => {
            if (!selected_group) {
                toastr.warning(t`Cannot run /member-get command outside of a group chat.`);
                return '';
            }
            if (field === '') {
                toastr.warning(t`'/member-get field=' argument required!`);
                return '';
            }
            field = field.toString();
            arg = arg.toString();
            if (!['name', 'index', 'id', 'avatar'].includes(field)) {
                toastr.warning(t`'/member-get field=' argument required!`);
                return '';
            }
            const isId = !isNaN(parseInt(arg));
            const groupMember = findGroupMemberId(arg, true);
            if (!groupMember) {
                toastr.warning(t`No group member found using ${isId ? 'id' : 'string'} ${arg}`);
                return '';
            }
            return groupMember[field];
        }),
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: t`Whether to retrieve the name, index, id, or avatar.`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                defaultValue: 'name',
                enumList: [
                    new SlashCommandEnumValue('name', t`Character name`),
                    new SlashCommandEnumValue('index', t`Group member index`),
                    new SlashCommandEnumValue('avatar', t`Character avatar`),
                    new SlashCommandEnumValue('id', t`Character index`),
                ],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`member index (starts with 0), name, or avatar`,
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.groupMembers(),
            }),
        ],
        helpString: t`Retrieves a group member's name, index, id, or avatar.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'member-disable',
        callback: disableGroupMemberCallback,
        aliases: ['disable', 'disablemember', 'memberdisable'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`member index (starts with 0) or name`,
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.groupMembers(),
            }),
        ],
        helpString: t`Disables a group member from being drafted for replies.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'member-enable',
        aliases: ['enable', 'enablemember', 'memberenable'],
        callback: enableGroupMemberCallback,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`member index (starts with 0) or name`,
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.groupMembers(),
            }),
        ],
        helpString: t`Enables a group member to be drafted for replies.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'member-add',
        callback: addGroupMemberCallback,
        aliases: ['addmember', 'memberadd'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`Character name - or unique character identifier (avatar key)`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: () => selected_group ? commonEnumProviders.characters('character')() : [],
            }),
        ],
        helpString: `
        <div>
            ${t`Adds a new group member to the group chat.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/member-add John Doe</code></pre>
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'member-remove',
        callback: removeGroupMemberCallback,
        aliases: ['removemember', 'memberremove'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`member index (starts with 0) or name`,
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.groupMembers(),
            }),
        ],
        helpString: `
        <div>
            ${t`Removes a group member from the group chat.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/member-remove 2</code></pre>
                    <pre><code>/member-remove John Doe</code></pre>
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'member-up',
        callback: moveGroupMemberUpCallback,
        aliases: ['upmember', 'memberup'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`member index (starts with 0) or name`,
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.groupMembers(),
            }),
        ],
        helpString: t`Moves a group member up in the group chat list.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'member-down',
        callback: moveGroupMemberDownCallback,
        aliases: ['downmember', 'memberdown'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`member index (starts with 0) or name`,
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.groupMembers(),
            }),
        ],
        helpString: t`Moves a group member down in the group chat list.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'member-peek',
        aliases: ['peek', 'memberpeek', 'peekmember'],
        callback: peekCallback,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`member index (starts with 0) or name`,
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.groupMembers(),
            }),
        ],
        helpString: `
        <div>
            ${t`Shows a group member character card without switching chats.`}
        </div>
        <div>
            <strong>${t`Examples:`}</strong>
            <ul>
                <li>
                    <pre><code>/peek Gloria</code></pre>
                    ${t`Shows the character card for the character named "Gloria".`}
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'member-count',
        callback: countGroupMemberCallback,
        aliases: ['countmember', 'membercount'],
        helpString: t`Returns the total number of group members in the group chat list.`,
    }));
}
