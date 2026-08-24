import { describe, test, expect, beforeEach } from '@jest/globals';
import {
    openRightMenu,
    closeRightMenu,
    isRightMenuOpen,
    getOpenRightMenus,
    resetRightMenuState,
} from '../public/scripts/right-menu-state.js';

beforeEach(() => {
    resetRightMenuState();
});

describe('openRightMenu / isRightMenuOpen', () => {
    test('a menu is not open until it is opened', () => {
        expect(isRightMenuOpen('rm_ch_create_block')).toBe(false);
    });

    test('opening a menu marks it open', () => {
        openRightMenu('rm_ch_create_block');
        expect(isRightMenuOpen('rm_ch_create_block')).toBe(true);
    });

    test('is idempotent', () => {
        openRightMenu('rm_ch_create_block');
        openRightMenu('rm_ch_create_block');
        expect(getOpenRightMenus()).toEqual(['rm_ch_create_block']);
    });

    test('accepts a leading "#" the same as a bare id', () => {
        openRightMenu('#rm_ch_create_block');
        expect(isRightMenuOpen('rm_ch_create_block')).toBe(true);
        expect(isRightMenuOpen('#rm_ch_create_block')).toBe(true);
    });
});

describe('decoupling from visibility (the actual point of this module)', () => {
    test('opening one menu does not close another that was already open', () => {
        // This is the behavior selectRightMenuWithAnimation() relies on: switching which menu is
        // *visible* must not implicitly close whichever menu was open before.
        openRightMenu('rm_ch_create_block');
        openRightMenu('rm_characters_block');
        expect(isRightMenuOpen('rm_ch_create_block')).toBe(true);
        expect(isRightMenuOpen('rm_characters_block')).toBe(true);
    });

    test('multiple menus can be open at once', () => {
        openRightMenu('rm_ch_create_block');
        openRightMenu('rm_group_chats_block');
        expect(getOpenRightMenus().sort()).toEqual(['rm_ch_create_block', 'rm_group_chats_block']);
    });
});

describe('closeRightMenu', () => {
    test('closes an open menu', () => {
        openRightMenu('rm_ch_create_block');
        closeRightMenu('rm_ch_create_block');
        expect(isRightMenuOpen('rm_ch_create_block')).toBe(false);
    });

    test('closing does not affect other open menus', () => {
        openRightMenu('rm_ch_create_block');
        openRightMenu('rm_characters_block');
        closeRightMenu('rm_ch_create_block');
        expect(isRightMenuOpen('rm_ch_create_block')).toBe(false);
        expect(isRightMenuOpen('rm_characters_block')).toBe(true);
    });

    test('closing a menu that was never open is a no-op, not an error', () => {
        expect(() => closeRightMenu('rm_ch_create_block')).not.toThrow();
        expect(isRightMenuOpen('rm_ch_create_block')).toBe(false);
    });
});

describe('resetRightMenuState', () => {
    test('clears everything', () => {
        openRightMenu('rm_ch_create_block');
        openRightMenu('rm_characters_block');
        resetRightMenuState();
        expect(getOpenRightMenus()).toEqual([]);
    });
});
