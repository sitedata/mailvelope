/**
 * Copyright (C) 2015-2017 Mailvelope GmbH
 * Licensed under the GNU Affero General Public License version 3
 */

/**
 * @fileOverview This controller implements handling of state and events
 * for the encryption editor like handling message data and recipients.
 */

import mvelo from '../lib/lib-mvelo';
import {getHash, deDup, sortAndDeDup, mapError, MvError, byteCount, normalizeArmored, dataURL2str} from '../lib/util';
import {extractFileExtension} from '../lib/file';
import * as l10n from '../lib/l10n';
import {prefs} from '../modules/prefs';
import * as model from '../modules/pgpModel';
import * as sub from './sub.controller';
import * as uiLog from '../modules/uiLog';
import {parseMessage, buildMail} from '../modules/mime';
import * as gmail from '../modules/gmail';
import {triggerSync} from './sync.controller';
import * as keyRegistry from '../modules/keyRegistry';
import {getById as getKeyringById, getPreferredKeyringId, getKeyData, getKeyByAddress, syncPublicKeys, getDefaultKeyFpr} from '../modules/keyring';
import {mapAddressKeyMapToFpr} from '../modules/key';
import {lookupKey} from './import.controller';

export default class EditorController extends sub.SubController {
  constructor(port) {
    super(port);
    if (!port) {
      this.mainType = 'editor';
      this.id = getHash();
    }
    this.encryptPromise = null;
    this.keyringId = null;
    this.popup = null;
    this.signKey = null;
    this.pwdControl = null;
    this.pgpMIME = false;
    this.options = {};
    this.integration = false;
    // register event handlers
    this.on('editor-mount', this.onEditorMount);
    this.on('editor-load', this.onEditorLoad);
    this.on('editor-plaintext', this.onEditorPlaintext);
    this.on('editor-user-input', this.onEditorUserInput);
    this.on('key-lookup', this.onKeyLookup);
    // standalone editor only
    this.on('editor-close', this.onEditorClose);
    this.on('sign-only', this.onSignOnly);
    // API only
    this.on('editor-container-encrypt', this.onEditorContainerEncrypt);
    this.on('editor-container-create-draft', this.onEditorContainerCreateDraft);
    this.on('editor-options', this.onEditorOptions);
    this.on('open-app', ({fragment}) => this.openApp(fragment));
  }

  async onEditorMount() {
    this.ports.editor.emit('set-mode', {
      embedded: Boolean(this.ports.editorCont),
      integration: this.integration
    });
    if (this.integration) {
      this.gmailCtrl = sub.getById(this.options.gmailCtrlId);
      try {
        await this.getAccessToken();
      } catch (error) {
        this.ports.editor.emit('error-message', {
          error: {
            code: 'AUTHORIZATION_FAILED',
            message: error.message,
            autoHide: false,
            dismissable: false
          }
        });
      }
    }
  }

  async getAccessToken() {
    return this.gmailCtrl.getAccessToken({
      ...this.options.userInfo,
      beforeAuth: () => this.beforeAuthorization(),
      afterAuth: () => this.afterAuthorization()
    });
  }

  beforeAuthorization() {
    this.ports.editor.emit('error-message', {
      error: {
        code: 'AUTHORIZATION_REQUIRED',
        message: l10n.get('gmail_integration_auth_error_send'),
        autoHide: false,
        dismissable: false
      }
    });
  }

  afterAuthorization() {
    this.ports.editor.emit('hide-notification');
    this.activateComponent();
  }

  activateComponent() {
    if (this.popup) {
      this.popup.activate();
    }
  }

  async onEditorLoad() {
    if (this.ports.editorCont) {
      this.ports.editorCont.emit('editor-ready');
    } else {
      // non-container case, set options
      this.onEditorOptions({
        keyringId: getPreferredKeyringId(),
        options: this.options,
      });
      // transfer recipient proposal and public key info to the editor
      let recipients;
      if (this.options.getRecipients) {
        recipients = await this.options.getRecipients();
      }
      await this.setRecipientData(recipients);
    }
  }

  /**
   * Set the recipient data in the editor.
   * @param  {Array} recipients - a list of potential recipient from the webmail ui
   */
  async setRecipientData(recipients) {
    let to = [];
    let cc = [];
    if (recipients) {
      // deduplicate email addresses
      let toEmails = (recipients.to || []).map(recipient => recipient.email);
      toEmails = deDup(toEmails); // just dedup, dont change order of user input
      to = toEmails.map(e => ({email: e}));
      let ccEmails = (recipients.cc || []).map(recipient => recipient.email);
      ccEmails = deDup(ccEmails); // just dedup, dont change order of user input
      cc = ccEmails.map(e => ({email: e}));
      // get all public keys from required keyrings
    }
    const keys = await getKeyData({keyringId: this.keyringId});
    this.emit('public-key-userids', {keys, to, cc});
  }

  async onEditorOptions(msg) {
    this.keyringId = msg.keyringId;
    this.options = msg.options;
    const keyring = getKeyringById(this.keyringId);
    const defaultKeyFpr = await keyring.getDefaultKeyFpr();
    const data = {
      signMsg: this.options.signMsg || prefs.general.auto_sign_msg,
      subject: this.options.subject || '',
      defaultKeyFpr
    };
    if (msg.options.privKeys) {
      data.privKeys = await keyring.getValidSigningKeys();
    }
    if (this.options.armoredDraft) {
      this.options.keepAttachments = true;
      this.scheduleDecrypt(this.options.armoredDraft);
    } else {
      if (this.options.quotedMail) {
        this.scheduleDecrypt(this.options.quotedMail);
      } else if (this.options.predefinedText) {
        data.text = this.options.predefinedText;
      }
    }
    if (this.options.attachments) {
      this.setAttachments(this.options.attachments);
    }
    triggerSync({keyringId: this.keyringId, force: true});
    this.ports.editor.emit('set-init-data', data);
  }

  onEditorClose(option = {cancel: false}) {
    const {cancel} = option;
    if (this.popup) {
      this.popup.close();
      this.popup = null;
      if (cancel) {
        this.encryptPromise.reject(new MvError('Editor dialog canceled.', 'EDITOR_DIALOG_CANCEL'));
      }
    }
  }

  async onEditorContainerEncrypt(msg) {
    this.pgpMIME = true;
    this.keyringId = msg.keyringId;
    const keyMap = await getKeyByAddress(this.keyringId, msg.recipients);
    await this.lookupMissingKeys(keyMap);
    const keyFprMap = mapAddressKeyMapToFpr(keyMap);
    if (Object.values(keyFprMap).some(keys => keys === false)) {
      const error = {
        message: 'No valid encryption key for recipient address',
        code: 'NO_KEY_FOR_RECIPIENT'
      };
      this.ports.editorCont.emit('error-message', {error});
      return;
    }
    let keyFprs = [];
    msg.recipients.forEach(recipient => {
      keyFprs = keyFprs.concat(keyFprMap[recipient]);
    });
    this.keyFprBuffer = sortAndDeDup(keyFprs);
    // ensure that all keys are available in the API keyring
    syncPublicKeys({keyringId: this.keyringId, keyIds: this.keyFprBuffer});
    this.ports.editor.emit('get-plaintext', {action: 'encrypt'});
  }

  async lookupMissingKeys(keyMap) {
    for (const [email, keys] of Object.entries(keyMap)) {
      if (!keys) {
        await lookupKey({keyringId: this.keyringId, email});
        // check if lookup successful
        const {[email]: keys} = await getKeyByAddress(this.keyringId, email);
        keyMap[email] = keys;
      }
    }
  }

  async onEditorContainerCreateDraft(msg) {
    this.pgpMIME = true;
    this.keyringId = msg.keyringId;
    this.options.reason = 'PWD_DIALOG_REASON_CREATE_DRAFT';
    const defaultKeyFpr = await getKeyringById(this.keyringId).getDefaultKeyFpr();
    if (defaultKeyFpr) {
      this.keyFprBuffer = [defaultKeyFpr];
    } else {
      const error = {
        message: 'No private key found for creating draft.',
        code: 'NO_KEY_FOR_ENCRYPTION'
      };
      this.ports.editorCont.emit('error-message', {error});
      return;
    }
    this.ports.editor.emit('get-plaintext', {action: 'encrypt', draft: true});
  }

  onSignOnly(msg) {
    this.signKeyFpr = msg.signKeyFpr;
    this.emit('get-plaintext', {action: 'sign'});
  }

  onEditorUserInput(msg) {
    uiLog.push(msg.source, msg.type);
  }

  /**
   * Lookup a recipient's public key with the key registry sources and
   * store it locally using a TOFU like (trust on first use) mechanic.
   * @param  {Object} msg   The event message object
   * @return {undefined}
   */
  async onKeyLookup(msg) {
    const options = msg.recipient;
    options.keyringId = this.keyringId;
    const result = await keyRegistry.lookup(options.email, this.keyringId);
    if (result) {
      await getKeyringById(this.keyringId).importKeys([{type: 'public', armored: result.armored}]);
    }
    await this.sendKeyUpdate();
  }

  async sendKeyUpdate() {
    // send updated key cache to editor
    const keys = await getKeyData({keyringId: this.keyringId});
    this.ports.editor.emit('key-update', {keys});
  }

  /**
   * Encrypt operation called by other controllers, opens editor popup
   * @param {Boolean} options.signMsg - sign message option is active
   * @param {String} options.predefinedText - text that will be added to the editor
   * @param {String} options.predefinedText - text that will be added to the editor
   * @param {String} quotedMail - mail that should be quoted
   * @param {boolean} quotedMailIndent - if true the quoted mail will be indented
   * @param {Function} getRecipients - retrieve recipient email addresses
   * @return {Promise<Object>} - {armored, recipients}
   */
  encrypt(options) {
    this.options = options;
    this.options.privKeys = true; // send private keys for signing key selection to editor
    let height = 680;
    if (this.options.integration) {
      this.integration = this.options.integration;
      height = 740;
    }
    return new Promise((resolve, reject) => {
      this.encryptPromise = {resolve, reject};
      mvelo.windows.openPopup(`components/editor/editor.html?id=${this.id}${this.integration ? `&quota=${gmail.MAIL_QUOTA}` : ''}`, {width: 820, height})
      .then(popup => {
        this.popup = popup;
        popup.addRemoveListener(() => this.onEditorClose({cancel: true}));
      });
    });
  }

  /**
   * A encrypted message will be decrypted and shown in the editor
   * @param  {String} armored
   */
  scheduleDecrypt(armored) {
    if (armored.length > 400000 && !this.popup) {
      // show spinner for large messages
      this.ports.editor.emit('decrypt-in-progress');
    }
    setTimeout(() => {
      this.decryptArmored(armored);
    }, 50);
  }

  setAttachments(attachments) {
    const encrypted = [];
    const regex = /.*\.(gpg|pgp|asc)/;
    for (const attachment of attachments) {
      const content = dataURL2str(attachment.data);
      if (regex.test(attachment.filename) && !/-----BEGIN\sPGP\sPUBLIC\sKEY\sBLOCK/.test(content)) {
        encrypted.push(attachment);
      } else {
        this.ports.editor.emit('set-attachment', {attachment: {content, ...attachment}});
      }
    }
    if (encrypted.length) {
      this.ports.editor.emit('decrypt-in-progress');
      this.decryptFiles(encrypted);
    }
  }

  /**
   * Decrypt armored message
   * @param {String} armored
   */
  async decryptArmored(armored) {
    try {
      const unlockKey = async options => {
        const result = await this.unlockKey(options);
        if (this.popup) {
          this.ports.editor.emit('hide-pwd-dialog');
        }
        return result;
      };
      let data = '';
      let signatures = [];
      if (/BEGIN\sPGP\sMESSAGE/.test(armored)) {
        const normalized = normalizeArmored(armored, /-----BEGIN PGP MESSAGE-----[\s\S]+?-----END PGP MESSAGE-----/);
        ({data, signatures} = await model.decryptMessage({
          armored: normalized,
          keyringId: this.keyringId,
          unlockKey,
          selfSigned: Boolean(this.options.armoredDraft),
          uiLogSource: 'security_log_editor'
        }));
      } else if (/BEGIN\sPGP\sSIGNED\sMESSAGE/.test(armored)) {
        ({data, signatures} = await model.verifyMessage({
          armored,
          keyringId: this.keyringId,
          uiLogSource: 'security_log_editor'
        }));
        data = decodeURIComponent(escape(data));
      } else {
        // clear text only
        data = mvelo.util.sanitizeHTML(armored);
      }
      const options = this.options;
      const ports = this.ports;
      const handlers = {
        onMessage(msg) {
          if (options.quotedMailIndent) {
            msg = msg.replace(/^(.|\n)/gm, '> $&');
          }
          if (options.quotedMailHeader) {
            msg = `${options.quotedMailHeader}\n${msg}`;
          }
          if (options.quotedMailIndent || options.quotedMailHeader) {
            msg = `\n\n${msg}`;
          }
          if (options.predefinedText) {
            msg = `${msg}\n\n${options.predefinedText}`;
          }
          ports.editor.emit('set-text', {text: msg});
        },
        onAttachment(part) {
          if (options.keepAttachments) {
            ports.editor.emit('set-attachment', {attachment: part});
          }
        }
      };
      if (this.options.armoredDraft) {
        if (!(signatures && signatures.length === 1 && signatures[0].valid)) {
          throw {message: 'Restoring of the draft failed due to invalid signature.'};
        }
      }
      parseMessage(data, handlers, 'text');
      this.ports.editor.emit('decrypt-end');
    } catch (error) {
      this.ports.editor.emit('decrypt-failed', {error: mapError(error)});
    }
  }

  async decryptFiles(encFiles) {
    try {
      const unlockKey = async options => {
        const result = await this.unlockKey(options);
        if (this.popup) {
          this.ports.editor.emit('hide-pwd-dialog');
        }
        return result;
      };
      await Promise.all(encFiles.map(async file => {
        const {filename, data} = await model.decryptFile({
          encryptedFile: {content: file.data, name: file.filename},
          unlockKey,
          uiLogSource: 'security_log_editor'
        });
        this.ports.editor.emit('set-attachment', {attachment: {content: data, filename, mimeType: file.mimeType}});
      }));

      this.ports.editor.emit('decrypt-end');
    } catch (error) {
      this.ports.editor.emit('decrypt-failed', {error: mapError(error)});
    }
  }

  /**
   * Receive plaintext from editor, initiate encryption
   * @param {String} options.action - 'sign' or 'encrypt'
   * @param {String} options.message - body of the message
   * @param {Array} options.keysTo - [key data object (user id, key id, fingerprint, email and name)]
   * @param {Array} options.keysCc - [key data object (user id, key id, fingerprint, email and name)]
   * @param {Array} options.attachments - file attachments
   * @param {Boolen} options.signMsg - indicator if (encrypted) message should be signed
   * @param {Array<String>} options.signKeyFpr - fingerprint of key to sign the message
   * @param {Boolean} options.noCache - do not use password cache, user interaction required
   */
  async onEditorPlaintext(options) {
    options.keys = [...options.keysTo, ...options.keysCc, ...options.keysEx];
    try {
      const {armored, encFiles} = await this.signAndEncrypt(options);
      this.ports.editor.emit('encrypt-end');
      if (!this.integration) {
        this.onEditorClose();
      }
      this.transferEncrypted({armored, encFiles, subject: options.subject, to: options.keysTo, cc: options.keysCc});
    } catch (err) {
      if (this.popup && err.code === 'PWD_DIALOG_CANCEL') {
        // popup case
        this.emit('hide-pwd-dialog');
        return;
      }
      console.log(err);
      const error = mapError(err);
      this.ports.editor.emit('error-message', {error});
      if (this.ports.editorCont) {
        this.ports.editorCont.emit('error-message', {error});
      }
      this.ports.editor.emit('encrypt-failed');
    }
  }

  /**
   * Encrypt, sign & encrypt, or sign only operation
   * @param {String} options.action - 'sign' or 'encrypt'
   * @param {String} options.message - body of the message
   * @param {String} options.keys - key data object (user id, key id, fingerprint, email and name)
   * @param {Array} options.attachments - file attachments
   * @param {Boolen} options.signMsg - indicator if (encrypted) message should be signed
   * @param {Array<String>} options.signKeyFpr - fingerprint of key to sign the message
   * @param {Boolean} options.noCache - do not use password cache, user interaction required
   * @return {Promise<String>} - message as armored block
   */
  async signAndEncrypt(options) {
    if (options.action === 'encrypt') {
      const noCache = options.noCache;
      const keyFprs = await this.getPublicKeyFprs(options.keys);
      let signKeyFpr;
      let unlockKey;
      if (options.signMsg) {
        signKeyFpr = options.signKeyFpr;
        if (!signKeyFpr) {
          const defaultKeyFpr = await getDefaultKeyFpr(this.keyringId);
          signKeyFpr = defaultKeyFpr;
        }
        if (!signKeyFpr) {
          throw new MvError('No private key found to sign this message.', 'NO_DEFAULT_KEY_FOUND');
        }
        unlockKey = async options => {
          options.noCache = noCache;
          options.reason = this.options.reason || 'PWD_DIALOG_REASON_SIGN';
          options.sync = !prefs.security.password_cache;
          return this.unlockKey(options);
        };
      }
      let data;
      let files = [];
      let encFiles = [];
      options.pgpMIME = this.pgpMIME;
      if (this.integration && !this.pgpMIME) {
        ({attachments: files, ...options} = options);
      }
      try {
        data = buildMail(options);
      } catch (error) {
        if (this.ports.editorCont) {
          this.ports.editorCont.emit('error-message', {error: mapError(error)});
        }
      }
      if (data === null) {
        throw new MvError('MIME building failed.');
      }
      const armored = await this.encryptMessage({
        data,
        keyFprs,
        signKeyFpr,
        unlockKey,
        noCache
      });
      if (!this.pgpMIME && files.length) {
        encFiles = await this.encryptFiles({
          files,
          keyFprs,
          signKeyFpr,
          unlockKey,
          noCache
        });
      }
      return {armored, encFiles};
    } else if (options.action === 'sign') {
      const armored = await this.signMessage({
        data: options.message,
        signKeyFpr: this.signKeyFpr
      });
      return {armored};
    }
  }

  /**
   * Encrypt only message
   * @param {String} data - message content
   * @param {Array<String>} keyFprs - encryption keys fingerprint
   * @return {Promise<String>} - message as armored block
   */
  encryptMessage({data, keyFprs, signKeyFpr, unlockKey, noCache}) {
    this.ports.editor.emit('encrypt-in-progress');
    return model.encryptMessage({
      data,
      keyringId: this.keyringId,
      encryptionKeyFprs: keyFprs,
      signingKeyFpr: signKeyFpr,
      unlockKey,
      noCache,
      uiLogSource: 'security_log_editor'
    });
  }

  encryptFiles({files, keyFprs, signKeyFpr, unlockKey, noCache}) {
    this.ports.editor.emit('encrypt-in-progress');
    return Promise.all(files.map(async file => {
      const fileExt = extractFileExtension(file.name);
      const encrypted = await model.encryptFile({
        plainFile: file,
        armor: fileExt === 'txt',
        keyringId: this.keyringId,
        encryptionKeyFprs: keyFprs,
        signingKeyFpr: signKeyFpr,
        unlockKey,
        noCache,
        uiLogSource: 'security_log_editor'
      });
      const base64encoded = btoa(encrypted);
      return {content: `data:application/octet-stream;base64,${base64encoded}`, size: byteCount(base64encoded), name: fileExt === 'txt' ? `${file.name}.asc` : `${file.name}.gpg`};
    }));
  }

  /**
   * Create a cleartext signature
   * @param {String} data
   * @return {Promise<String>}
   */
  signMessage({data, signKeyFpr}) {
    const unlockKey = async options => {
      options.reason = 'PWD_DIALOG_REASON_SIGN';
      return this.unlockKey(options);
    };
    return model.signMessage({
      data,
      keyringId: this.keyringId,
      unlockKey,
      signingKeyFpr: signKeyFpr
    });
  }

  /**
   * Transfer the encrypted/signed armored message and recipients back to the webmail interface or editor container
   * @param  {String} options.armored   The encrypted/signed message
   * @param  {Array}  options.keys      The keys used to encrypt the message
   */
  transferEncrypted({armored, encFiles, subject, to, cc}) {
    if (this.ports.editorCont) {
      this.ports.editorCont.emit('encrypted-message', {message: armored});
    } else {
      to = to.map(key => ({name: key.name, email: key.email}));
      cc = cc.map(key => ({name: key.name, email: key.email}));
      this.encryptPromise.resolve({armored, encFiles, subject, to, cc});
    }
  }

  async unlockKey({key, noCache, reason = 'PWD_DIALOG_REASON_DECRYPT', sync = true}) {
    const pwdControl = sub.factory.get('pwdDialog');
    const openPopup = !this.popup;
    const beforePasswordRequest = id => this.popup && this.ports.editor.emit('show-pwd-dialog', {id});
    const unlockedKey = await pwdControl.unlockKey({key, reason, openPopup, noCache, beforePasswordRequest});
    this.ports.editor.emit('encrypt-in-progress');
    if (sync) {
      triggerSync({keyringId: this.keyringId, key: unlockedKey.key, password: unlockedKey.password});
    }
    return unlockedKey.key;
  }

  /**
   * Collect all the key fingerprints to encrypto to, including the sender's key.
   * @param  {Array<Object>} keys - the public key objects containing the key fingerprint
   * @return {Array<String>} - A collection of all key fingerprints to encrypt to
   */
  async getPublicKeyFprs(keys) {
    let keyFprs;
    // prefer keyFprBuffer
    if (this.keyFprBuffer) {
      keyFprs = this.keyFprBuffer;
    } else {
      keyFprs = keys.map(key => key.fingerprint);
    }
    if (prefs.general.auto_add_primary) {
      // get the sender key fingerprint
      const defaultKeyFpr = await getKeyringById(this.keyringId).getDefaultKeyFpr();
      if (defaultKeyFpr) {
        keyFprs.push(defaultKeyFpr);
      }
    }
    // deduplicate
    return sortAndDeDup(keyFprs);
  }
}
