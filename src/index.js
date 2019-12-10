/*
 * Copyright 2015, Yahoo Inc.
 * Copyrights licensed under the New BSD License.
 * See the accompanying LICENSE file for terms.
 */

import * as p from 'path';
import {writeFileSync} from 'fs';
import {sync as mkdirpSync} from 'mkdirp';
import printICUMessage from './print-icu-message';

const COMPONENT_NAMES = [
    'FormattedMessage',
    'FormattedHTMLMessage',
];

const FUNCTION_NAMES = [
    'defineMessages',
];

const DESCRIPTOR_PROPS = new Set(['id', 'description', 'defaultMessage']);

const EXTRACTED = Symbol('ReactIntlExtracted');
const MESSAGES  = Symbol('ReactIntlMessages');

export default function ({types: t}) {
    function warnOrThrow(opts, path, message) {
        if (opts && opts.errorsAsWarnings) {
            if (path.log && path.log.warn) {
                path.log.warn(message)
            } else {
                console.warn(message)
            }
        } else {
            throw path.buildCodeFrameError(message)
        }
    }

    function getModuleSourceName(opts) {
        return opts.moduleSourceName || 'react-intl';
    }

    function evaluatePath(path, opts) {
        const evaluated = path.evaluate();
        if (evaluated.confident) {
            return evaluated.value;
        }

        warnOrThrow(opts, path, `
            '[React Intl] Messages must be statically evaluate-able for extraction.'
        `)
    }

    function getMessageDescriptorKey(path, opts) {
        if (path.isIdentifier() || path.isJSXIdentifier()) {
            return path.node.name;
        }

        return evaluatePath(path, opts);
    }

    function getMessageDescriptorValue(path, opts) {
        if (path.isJSXExpressionContainer()) {
            path = path.get('expression');
        }

        // Always trim the Message Descriptor values.
        const descriptorValue = evaluatePath(path, opts);

        if (typeof descriptorValue === 'string') {
            return descriptorValue.trim();
        }

        return descriptorValue;
    }

    function getICUMessageValue(messagePath, {isJSXSource = false} = {}, opts) {
        const message = getMessageDescriptorValue(messagePath, opts);

        try {
            return printICUMessage(message);
        } catch (parseError) {
            if (isJSXSource &&
                messagePath.isLiteral() &&
                message.indexOf('\\\\') >= 0) {

                warnOrThrow(opts, messagePath, 
                    '[React Intl] Message failed to parse. ' +
                    'It looks like `\\`s were used for escaping, ' +
                    'this won\'t work with JSX string literals. ' +
                    'Wrap with `{}`. ' +
                    'See: http://facebook.github.io/react/docs/jsx-gotchas.html'
                );
            }

            warnOrThrow(opts, messagePath,
                '[React Intl] Message failed to parse. ' +
                'See: http://formatjs.io/guides/message-syntax/' +
                `\n${parseError}`
            );
        }
    }

    function createMessageDescriptor(propPaths, opts) {
        return propPaths.reduce((hash, [keyPath, valuePath]) => {
            const key = getMessageDescriptorKey(keyPath, opts);

            if (DESCRIPTOR_PROPS.has(key)) {
                hash[key] = valuePath;
            }

            return hash;
        }, {});
    }

    function evaluateMessageDescriptor({...descriptor}, {isJSXSource = false} = {}, opts) {
        Object.keys(descriptor).forEach((key) => {
            const valuePath = descriptor[key];

            if (key === 'defaultMessage') {
                descriptor[key] = getICUMessageValue(valuePath, {isJSXSource}, opts);
            } else {
                descriptor[key] = getMessageDescriptorValue(valuePath, opts);
            }
        });

        return descriptor;
    }

    function storeMessage({id, description, defaultMessage = ''}, path, state) {
        const {file, opts} = state;

        if (!id) {
            warnOrThrow(opts, path, 
                '[React Intl] Message Descriptors require an `id`.'
            )
        }

        if (!defaultMessage && !opts.optionalDefaultMessages) {
            warnOrThrow(opts, path, 
                '[React Intl] Message Descriptors require `defaultMessage`.'
            )
        }

        const messages = file.get(MESSAGES);
        if (messages.has(id)) {
            const existing = messages.get(id);

            if (description !== existing.description ||
                defaultMessage !== existing.defaultMessage) {

                warnOrThrow(opts, path, 
                    `[React Intl] Duplicate message id: "${id}", ` +
                    'but the `description` and/or `defaultMessage` are different.'
                )
            }
        }

        if (opts.enforceDescriptions) {
            if (
                !description ||
                (typeof description === 'object' && Object.keys(description).length < 1)
            ) {
                warnOrThrow(opts, path, 
                    '[React Intl] Message must have a `description`.'
                )
            }
        }

        let loc;
        if (opts.extractSourceLocation) {
            loc = {
                file: p.relative(process.cwd(), file.opts.filename),
                ...path.node.loc,
            };
        }

        messages.set(id, {id, description, defaultMessage, ...loc});
    }

    function referencesImport(path, mod, importedNames) {
        if (!(path.isIdentifier() || path.isJSXIdentifier())) {
            return false;
        }

        return importedNames.some((name) => path.referencesImport(mod, name));
    }

    function tagAsExtracted(path) {
        path.node[EXTRACTED] = true;
    }

    function wasExtracted(path) {
        return !!path.node[EXTRACTED];
    }

    return {
        pre(file) {
            if (!file.has(MESSAGES)) {
                file.set(MESSAGES, new Map());
            }
        },

        post(file) {
            const {opts} = this;
            const {filename} = file.opts;

            const basename = p.basename(filename, p.extname(filename));
            const messages = file.get(MESSAGES);
            const descriptors = [...messages.values()];
            file.metadata['react-intl'] = {messages: descriptors};

            if (opts.messagesDir && descriptors.length > 0) {
                // Make sure the relative path is "absolute" before
                // joining it with the `messagesDir`.
                const relativePath = p.join(
                    p.sep,
                    p.relative(process.cwd(), filename)
                );

                const messagesFilename = p.join(
                    opts.messagesDir,
                    p.dirname(relativePath),
                    basename + '.json'
                );

                const messagesFile = JSON.stringify(descriptors, null, 2);

                mkdirpSync(p.dirname(messagesFilename));
                writeFileSync(messagesFilename, messagesFile);
            }
        },

        visitor: {
            JSXOpeningElement(path, state) {
                if (wasExtracted(path)) {
                    return;
                }

                const {file, opts} = state;
                const moduleSourceName = getModuleSourceName(opts);
                const name = path.get('name');

                if (name.referencesImport(moduleSourceName, 'FormattedPlural')) {
                    file.log.warn(
                        `[React Intl] Line ${path.node.loc.start.line}: ` +
                        'Default messages are not extracted from ' +
                        '<FormattedPlural>, use <FormattedMessage> instead.'
                    );

                    return;
                }

                if (referencesImport(name, moduleSourceName, COMPONENT_NAMES)) {
                    const attributes = path.get('attributes')
                        .filter((attr) => attr.isJSXAttribute());

                    let descriptor = createMessageDescriptor(
                        attributes.map((attr) => [
                            attr.get('name'),
                            attr.get('value'),
                        ]),
                        opts
                    );

                    // In order for a default message to be extracted when
                    // declaring a JSX element, it must be done with standard
                    // `key=value` attributes. But it's completely valid to
                    // write `<FormattedMessage {...descriptor} />` or
                    // `<FormattedMessage id={dynamicId} />`, because it will be
                    // skipped here and extracted elsewhere. The descriptor will
                    // be extracted only if a `defaultMessage` prop exists.
                    if (descriptor.defaultMessage || opts.optionalDefaultMessages) {
                        // Evaluate the Message Descriptor values in a JSX
                        // context, then store it.
                        descriptor = evaluateMessageDescriptor(descriptor, {
                            isJSXSource: true,
                        }, opts);

                        storeMessage(descriptor, path, state);

                        // Remove description since it's not used at runtime.
                        attributes.some((attr) => {
                            const ketPath = attr.get('name');
                            if (getMessageDescriptorKey(ketPath, opts) === 'description') {
                                attr.remove();
                                return true;
                            }
                        });

                        // Tag the AST node so we don't try to extract it twice.
                        tagAsExtracted(path);
                    }
                }
            },

            CallExpression(path, state) {
                const {opts} = state;
                const moduleSourceName = getModuleSourceName(state.opts);
                const callee = path.get('callee');

                function assertObjectExpression(node) {
                    if (!(node && node.isObjectExpression())) {
                        warnOrThrow(opts, path, 
                            `[React Intl] \`${callee.node.name}()\` must be ` +
                            'called with an object expression with values ' +
                            'that are React Intl Message Descriptors, also ' +
                            'defined as object expressions.'
                        )
                    }
                }

                function processMessageObject(messageObj) {
                    assertObjectExpression(messageObj);

                    if (wasExtracted(messageObj)) {
                        return;
                    }

                    const properties = messageObj.get('properties');

                    let descriptor = createMessageDescriptor(
                        properties.map((prop) => [
                            prop.get('key'),
                            prop.get('value'),
                        ]),
                        opts
                    );
 
                    // Evaluate the Message Descriptor values, then store it.
                    descriptor = evaluateMessageDescriptor(descriptor, {
                        isJSXSource: false,
                    }, opts);
                    storeMessage(descriptor, messageObj, state);

                    // Remove description since it's not used at runtime.
                    messageObj.replaceWith(t.objectExpression([
                        t.objectProperty(
                            t.stringLiteral('id'),
                            t.stringLiteral(descriptor.id)
                        ),
                        t.objectProperty(
                            t.stringLiteral('defaultMessage'),
                            descriptor.defaultMessage 
                                ? t.stringLiteral(descriptor.defaultMessage)
                                : t.stringLiteral('')
                        ),
                    ]));

                    // Tag the AST node so we don't try to extract it twice.
                    tagAsExtracted(messageObj);
                }

                if (referencesImport(callee, moduleSourceName, FUNCTION_NAMES)) {
                    const messagesObj = path.get('arguments')[0];

                    assertObjectExpression(messagesObj);

                    messagesObj.get('properties')
                        .map((prop) => prop.get('value'))
                        .forEach(processMessageObject);
                }
            },
        },
    };
}
