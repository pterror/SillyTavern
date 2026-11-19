import { defineArea } from '@st/server-ui';
import type { User } from '@st/server-ui';
import { actions, FAMILIES, VIEW } from './protocol.ts';
import type { Catalog, Family, Preset, PresetsView } from './protocol.ts';

export type Ports = {
    binding(user: User): Promise<boolean>;
    bind(user: User, enabled: boolean): Promise<void>;
    settingsHashes(user: User): Promise<Record<string, number>>;
    list(user: User, family: Family): Promise<Catalog>;
    select(user: User, family: Family, name: string): Promise<void>;
    current(user: User, family: Family): Promise<Record<string, unknown>>;
    save(user: User, family: Family, preset: Preset): Promise<string | null>;
    rename(user: User, family: Family, name: string, to: string): Promise<string | null>;
    remove(user: User, family: Family, name: string): Promise<boolean>;
    defaults(user: User, family: Family, name: string): Promise<Record<string, unknown> | null>;
    order(user: User, family: Family, names: string[]): Promise<void>;
};

export function presetsArea(ports: Ports) {
    const changed = { changed: [VIEW, 'settings'] };
    const exists = async (user: User, family: Family, name: string) =>
        (await ports.list(user, family)).presets.some((preset) => preset.name === name);
    const save = async (user: User, family: Family, name: string, data: Record<string, unknown>, activate = true) => {
        if (family === 'kobold' && name === 'gui') return { refused: 'GUI settings are not a saved preset.' };
        const saved = await ports.save(user, family, { name, data });
        if (saved === null || saved === '') return { refused: 'The preset could not be saved.' };
        if (activate) await ports.select(user, family, saved);
        return changed;
    };
    return defineArea({
        schemas: actions,
        views: {
            [VIEW]: async ({ user }): Promise<PresetsView> =>
                Object.assign(
                    Object.fromEntries(
                        await Promise.all(FAMILIES.map(async (family) => [family, await ports.list(user, family)])),
                    ),
                    { settingsHashes: await ports.settingsHashes(user), bindConnection: await ports.binding(user) },
                ) as PresetsView,
        },
        actions: {
            'presets.bindConnection': async ({ user }, { enabled }) => {
                await ports.bind(user, enabled);
                return changed;
            },
            'presets.select': async ({ user }, { family, name }) => {
                if (!(family === 'kobold' && name === 'gui') && !(await exists(user, family, name)))
                    return { refused: 'The preset no longer exists.' };
                await ports.select(user, family, name);
                return changed;
            },
            'presets.save': async ({ user }, { family, name, activate }) => {
                if (family === 'kobold' && name === 'gui') return { refused: 'Cannot update GUI settings.' };
                return save(user, family, name, await ports.current(user, family), activate);
            },
            'presets.import': async ({ user }, { family, name, data, overwrite, activate }) => {
                if (!overwrite && (await exists(user, family, name)))
                    return { refused: 'A preset with that name already exists.' };
                return save(user, family, name, data, activate);
            },
            'presets.rename': async ({ user }, { family, name, to }) => {
                if (!(await exists(user, family, name))) return { refused: 'The preset no longer exists.' };
                const selected = (await ports.list(user, family)).selected === name;
                const renamed = await ports.rename(user, family, name, to);
                if (renamed === null || renamed === '') return { refused: 'The name is invalid or already taken.' };
                if (selected) await ports.select(user, family, renamed);
                return changed;
            },
            'presets.delete': async ({ user }, { family, name }) => {
                const before = await ports.list(user, family);
                if (!before.presets.some((preset) => preset.name === name))
                    return { refused: 'The preset no longer exists.' };
                if (!(await ports.remove(user, family, name))) return { refused: 'The preset could not be deleted.' };
                if (before.selected === name) {
                    const next =
                        before.presets.find((preset) => preset.name !== name)?.name ??
                        (family === 'kobold' ? 'gui' : '');
                    await ports.select(user, family, next);
                }
                return changed;
            },
            'presets.restore': async ({ user }, { family, name }) => {
                if (!(await exists(user, family, name))) return { refused: 'The preset no longer exists.' };
                const defaults = await ports.defaults(user, family, name);
                if (defaults && Object.keys(defaults).length === 0)
                    return { refused: 'The shipped preset could not be read.' };
                if (defaults) return save(user, family, name, defaults);
                await ports.select(user, family, name);
                return changed;
            },
            'presets.order': async ({ user }, { family, names }) => {
                const catalog = await ports.list(user, family);
                const available = new Set(catalog.presets.map((preset) => preset.name));
                if (
                    names.length !== available.size ||
                    new Set(names).size !== names.length ||
                    names.some((name) => !available.has(name))
                )
                    return { refused: 'The preset list changed. Open the order editor again.' };
                await ports.order(user, family, names);
                return changed;
            },
        },
    });
}
