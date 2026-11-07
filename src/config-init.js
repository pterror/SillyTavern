import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import color from 'chalk';
import { serverDirectory } from './server-directory.js';
import { isPlainObject, keyToEnv, setConfigFilePath, stringToBool } from './util.js';
import { getAtPath, setAtPath, unsetAtPath } from '../public/scripts/hash-utils.js';

const keyMigrationMap = [
    {
        oldKey: 'disableChatBackup',
        newKey: 'backups.chat.enabled',
        migrate: (value) => !value,
    },
    {
        oldKey: 'numberOfBackups',
        newKey: 'backups.common.numberOfBackups',
        migrate: (value) => value,
    },
    {
        oldKey: 'maxTotalChatBackups',
        newKey: 'backups.chat.maxTotalBackups',
        migrate: (value) => value,
    },
    {
        oldKey: 'chatBackupThrottleInterval',
        newKey: 'backups.chat.throttleInterval',
        migrate: (value) => value,
    },
    {
        oldKey: 'minLogLevel',
        newKey: 'logging.minLogLevel',
        migrate: (value) => value,
    },
    {
        oldKey: 'cookieSecret',
        newKey: 'cookieSecret',
        migrate: () => void 0,
        remove: true,
    },
    {
        oldKey: 'autorun',
        newKey: 'browserLaunch.enabled',
        migrate: (value) => value,
    },
    {
        oldKey: 'autorunHostname',
        newKey: 'browserLaunch.hostname',
        migrate: (value) => value,
    },
    {
        oldKey: 'autorunPortOverride',
        newKey: 'browserLaunch.port',
        migrate: (value) => value,
    },
    {
        oldKey: 'avoidLocalhost',
        newKey: 'browserLaunch.avoidLocalhost',
        migrate: (value) => value,
    },
    {
        oldKey: 'extras.promptExpansionModel',
        newKey: 'extras.promptExpansionModel',
        migrate: () => void 0,
        remove: true,
    },
    {
        oldKey: 'autheliaAuth',
        newKey: 'sso.autheliaAuth',
        migrate: (value) => value,
    },
    {
        oldKey: 'authentikAuth',
        newKey: 'sso.authentikAuth',
        migrate: (value) => value,
    },
];

/**
 * Gets all keys from an object recursively.
 * @param {object} obj Object to get all keys from
 * @param {string} prefix Prefix to prepend to all keys
 * @returns {string[]} Array of all keys in the object
 */
function getAllKeys(obj, prefix = '') {
    if (typeof obj !== 'object' || Array.isArray(obj) || obj === null) {
        return [];
    }

    return Object.keys(obj).flatMap(key => {
        const newPrefix = prefix ? `${prefix}.${key}` : key;
        if (typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
            return getAllKeys(obj[key], newPrefix);
        } else {
            return [newPrefix];
        }
    });
}

/**
 * Fills each key `target` lacks from `defaults`, recursing into objects both have. Arrays are values: a configured
 * list is kept whole.
 * @param {object} target
 * @param {object} defaults
 * @returns {object} `target`
 */
function withDefaults(target, defaults) {
    for (const [key, value] of Object.entries(defaults)) {
        if (target[key] === undefined) {
            target[key] = value;
        } else if (isPlainObject(target[key]) && isPlainObject(value)) {
            withDefaults(target[key], value);
        }
    }
    return target;
}

/**
 * @returns {object}
 */
export function getDefaultYamlConfig() {
    return yaml.parse(fs.readFileSync(path.join(serverDirectory, './default/config.yaml'), 'utf8'));
}

/**
 * Compares the current config.yaml with the default config.yaml and adds any missing values.
 * @param {string} configPath Path to config.yaml
 */
export function addMissingConfigValues(configPath) {
    try {
        const defaultConfig = getDefaultYamlConfig();

        if (!fs.existsSync(configPath)) {
            console.warn(color.yellow(`Warning: config.yaml not found at ${configPath}. Creating a new one with default values.`));
            fs.writeFileSync(configPath, yaml.stringify(defaultConfig));
            return;
        }

        let config = yaml.parse(fs.readFileSync(configPath, 'utf8'));

        // Migrate old keys to new keys
        const migratedKeys = [];
        for (const { oldKey, newKey, migrate, remove } of keyMigrationMap) {
            // Migrate environment variables
            const oldEnvKey = keyToEnv(oldKey);
            const newEnvKey = keyToEnv(newKey);
            if (process.env[oldEnvKey] && !process.env[newEnvKey]) {
                const oldValue = process.env[oldEnvKey];
                const newValue = migrate(stringToBool(oldValue));
                process.env[newEnvKey] = newValue;
                delete process.env[oldEnvKey];
                console.warn(color.yellow(`Warning: Using a deprecated environment variable: ${oldEnvKey}. Please use ${newEnvKey} instead.`));
                console.log(`Redirecting ${color.blue(oldEnvKey)}=${oldValue} -> ${color.blue(newEnvKey)}=${newValue}`);
            }

            if (getAtPath(config, oldKey) !== undefined) {
                if (remove) {
                    unsetAtPath(config, oldKey);
                    migratedKeys.push({
                        oldKey,
                        newValue: void 0,
                    });
                    continue;
                }

                const oldValue = getAtPath(config, oldKey);
                const newValue = migrate(oldValue);
                setAtPath(config, newKey, newValue);
                unsetAtPath(config, oldKey);

                migratedKeys.push({
                    oldKey,
                    newKey,
                    oldValue,
                    newValue,
                });
            }
        }

        // Get all keys from the original config
        const originalKeys = getAllKeys(config);

        config = withDefaults(config ?? {}, defaultConfig);

        // Get all keys from the updated config
        const updatedKeys = getAllKeys(config);

        // Find the keys that were added
        const original = new Set(originalKeys);
        const addedKeys = updatedKeys.filter(key => !original.has(key));

        if (addedKeys.length === 0 && migratedKeys.length === 0) {
            return;
        }

        if (addedKeys.length > 0) {
            console.log('Adding missing config values to config.yaml:', addedKeys);
        }

        if (migratedKeys.length > 0) {
            console.log('Migrating config values in config.yaml:', migratedKeys);
        }

        fs.writeFileSync(configPath, yaml.stringify(config));
    } catch (error) {
        console.warn(color.yellow('Could not add missing config values to config.yaml'), error);
    }
}

/**
 * Performs early initialization tasks before the server starts.
 * @param {string} configPath Path to config.yaml
 */
export function initConfig(configPath) {
    console.log('Using config path:', color.green(configPath));
    setConfigFilePath(configPath);
    addMissingConfigValues(configPath);
}
