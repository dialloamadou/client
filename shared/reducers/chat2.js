// @flow
import * as Chat2Gen from '../actions/chat2-gen'
import * as Constants from '../constants/chat2'
import * as I from 'immutable'
import * as RPCChatTypes from '../constants/types/rpc-chat-gen'
import * as RPCTypes from '../constants/types/rpc-gen'
import * as Types from '../constants/types/chat2'
import {isMobile} from '../constants/platform'

const initialState: Types.State = Constants.makeState()

// Backend gives us messageIDs sometimes so we need to find our ordinal
const messageIDToOrdinal = (messageMap, pendingOutboxToOrdinal, conversationIDKey, messageID) => {
  // A message we didn't send in this session?
  let m = messageMap.getIn([conversationIDKey, Types.numberToOrdinal(messageID)])
  if (m && m.id === messageID) {
    return m.ordinal
  }
  // Search through our sent messages
  const pendingOrdinal = pendingOutboxToOrdinal.get(conversationIDKey, I.Map()).find(o => {
    m = messageMap.getIn([conversationIDKey, o])
    if (m && m.id === messageID) {
      return true
    }
  })

  if (pendingOrdinal) {
    return pendingOrdinal
  }

  return null
}

const metaMapReducer = (metaMap, action) => {
  switch (action.type) {
    case Chat2Gen.metaRequestingTrusted:
      return metaMap.withMutations(map =>
        (action.payload.force
          ? action.payload.conversationIDKeys
          : Constants.getConversationIDKeyMetasToLoad(action.payload.conversationIDKeys, metaMap)
        ).forEach(conversationIDKey =>
          map.update(conversationIDKey, meta => (meta ? meta.set('trustedState', 'requesting') : meta))
        )
      )
    case Chat2Gen.metaReceivedError: {
      const {error} = action.payload
      if (error) {
        switch (error.typ) {
          case RPCChatTypes.localConversationErrorType.otherrekeyneeded: // fallthrough
          case RPCChatTypes.localConversationErrorType.selfrekeyneeded: {
            const {username, conversationIDKey} = action.payload
            const participants = error.rekeyInfo
              ? I.OrderedSet(
                  [].concat(error.rekeyInfo.writerNames, error.rekeyInfo.readerNames).filter(Boolean)
                )
              : I.OrderedSet(error.unverifiedTLFName.split(','))
            const old = metaMap.get(conversationIDKey)
            const rekeyers = I.Set(
              error.typ === RPCChatTypes.localConversationErrorType.selfrekeyneeded
                ? [username || '']
                : (error.rekeyInfo && error.rekeyInfo.rekeyers) || []
            )
            return metaMap.set(
              conversationIDKey,
              Constants.makeConversationMeta({
                conversationIDKey,
                participants,
                rekeyers,
                snippet: error.message,
                teamType: old ? old.teamType : 'adhoc',
                teamname: old ? old.teamname : '',
                timestamp: old ? old.timestamp : 0,
                trustedState: 'error',
              })
            )
          }
          default:
            return metaMap.update(
              action.payload.conversationIDKey,
              meta =>
                meta
                  ? meta.withMutations(m => {
                      m.set('trustedState', 'error')
                      m.set('snippet', error.message)
                    })
                  : meta
            )
        }
      } else {
        return metaMap.delete(action.payload.conversationIDKey)
      }
    }
    case Chat2Gen.metasReceived:
      return metaMap.withMutations(map => {
        action.payload.metas.forEach(meta => {
          const old = map.get(meta.conversationIDKey)
          map.set(meta.conversationIDKey, old ? Constants.updateMeta(old, meta) : meta)
        })
      })
    case Chat2Gen.inboxRefresh:
      return action.payload.clearAllData ? metaMap.clear() : metaMap
    default:
      return metaMap
  }
}

const messageMapReducer = (messageMap, action, pendingOutboxToOrdinal) => {
  switch (action.type) {
    case Chat2Gen.messageEdit: // fallthrough
    case Chat2Gen.messageDelete:
      return messageMap.updateIn(
        [action.payload.conversationIDKey, action.payload.ordinal],
        message =>
          message && message.type === 'text'
            ? message.set('submitState', action.type === Chat2Gen.messageDelete ? 'deleting' : 'editing')
            : message
      )
    case Chat2Gen.inboxRefresh:
      return action.payload.clearAllData ? messageMap.clear() : messageMap
    case Chat2Gen.messageWasEdited: {
      const {conversationIDKey, messageID, text} = action.payload

      const ordinal = messageIDToOrdinal(messageMap, pendingOutboxToOrdinal, conversationIDKey, messageID)
      if (!ordinal) {
        return messageMap
      }

      const message = messageMap.getIn([conversationIDKey, ordinal])
      if (!message) {
        return messageMap
      }
      const existingOrdinal =
        (message.type === 'text' || message.type === 'attachment') && message.outboxID
          ? pendingOutboxToOrdinal.getIn([message.conversationIDKey, message.outboxID])
          : null

      // Updated all messages (real ordinal and fake one)
      const ordinals = [ordinal, ...(existingOrdinal ? [existingOrdinal] : [])]

      let editedMap = messageMap
      ordinals.forEach(o => {
        editedMap = o
          ? editedMap.updateIn(
              [conversationIDKey, o],
              message =>
                !message || message.type !== 'text'
                  ? message
                  : message.withMutations(m => {
                      m.set('text', text)
                      m.set('hasBeenEdited', true)
                      m.set('submitState', null)
                    })
            )
          : editedMap
      })
      return editedMap
    }
    case Chat2Gen.messagesWereDeleted: {
      const {conversationIDKey, messageIDs} = action.payload

      return messageMap.update(conversationIDKey, I.Map(), (map: I.Map<Types.Ordinal, Types.Message>) =>
        map.withMutations(m => {
          messageIDs.forEach(messageID => {
            const ordinal = messageIDToOrdinal(
              messageMap,
              pendingOutboxToOrdinal,
              conversationIDKey,
              messageID
            )
            if (!ordinal) {
              return
            }

            m.update(ordinal, message => {
              if (!message) {
                return message
              }
              return Constants.makeMessageDeleted({
                author: message.author,
                conversationIDKey: message.conversationIDKey,
                id: message.id,
                ordinal: message.ordinal,
                timestamp: message.timestamp,
              })
            })
          })
        })
      )
    }
    case Chat2Gen.attachmentLoading:
      return messageMap.updateIn([action.payload.conversationIDKey, action.payload.ordinal], message => {
        if (!message || message.type !== 'attachment') {
          return message
        }
        return action.payload.isPreview
          ? message.set('previewTransferState', 'downloading')
          : message.set('transferProgress', action.payload.ratio).set('transferState', 'downloading')
      })
    case Chat2Gen.attachmentLoaded:
      return messageMap.updateIn([action.payload.conversationIDKey, action.payload.ordinal], message => {
        if (!message || message.type !== 'attachment') {
          return message
        }
        const path = action.error ? '' : action.payload.path
        return action.payload.isPreview
          ? message.set('devicePreviewPath', path).set('previewTransferState', null)
          : message
              .set('transferProgress', 0)
              .set('transferState', null)
              .set('deviceFilePath', path)
      })
    case Chat2Gen.attachmentDownloaded:
      return messageMap.updateIn([action.payload.conversationIDKey, action.payload.ordinal], message => {
        if (!message || message.type !== 'attachment') {
          return message
        }
        const path = action.error ? '' : action.payload.path
        return message.set('downloadPath', path)
      })
    default:
      return messageMap
  }
}

const messageOrdinalsReducer = (messageOrdinals, action) => {
  // Note: on a delete we leave the ordinals in the list
  switch (action.type) {
    case Chat2Gen.inboxRefresh:
      return action.payload.clearAllData ? messageOrdinals.clear() : messageOrdinals
    default:
      return messageOrdinals
  }
}

const badgeKey = String(isMobile ? RPCTypes.commonDeviceType.mobile : RPCTypes.commonDeviceType.desktop)

const rootReducer = (state: Types.State = initialState, action: Chat2Gen.Actions): Types.State => {
  switch (action.type) {
    case Chat2Gen.resetStore:
      return initialState
    case Chat2Gen.setLoading:
      return state.update('loadingMap', loading => {
        const count = loading.get(action.payload.key, 0) + (action.payload.loading ? 1 : -1)
        if (count > 0) {
          return loading.set(action.payload.key, count)
        } else if (count === 0) {
          return loading.delete(action.payload.key)
        } else {
          console.log('Setting negative chat loading key', action.payload.key, count)
          return loading.set(action.payload.key, count)
          // TODO talk to mike. sync calls don't seem to always start with syncStarting so we go negative
          // never allow negative
          // throw new Error(`Negative loading in chat ${action.payload.key}`)
        }
      })
    case Chat2Gen.selectConversation:
      return state.set('selectedConversation', action.payload.conversationIDKey)
    case Chat2Gen.setInboxFilter:
      return state.set('inboxFilter', action.payload.filter)
    case Chat2Gen.setPendingSelected:
      return state.set('pendingSelected', action.payload.selected)
    case Chat2Gen.setPendingMode:
      return state.set('pendingMode', action.payload.pendingMode)
    case Chat2Gen.setPendingConversationUsers:
      return state.set('pendingConversationUsers', I.Set(action.payload.users))
    case Chat2Gen.badgesUpdated: {
      const badgeMap = I.Map(
        action.payload.conversations.map(({convID, badgeCounts}) => [
          Types.conversationIDToKey(convID),
          badgeCounts[badgeKey] || 0,
        ])
      )
      const unreadMap = I.Map(
        action.payload.conversations.map(({convID, unreadMessages}) => [
          Types.conversationIDToKey(convID),
          unreadMessages,
        ])
      )
      return state.withMutations(s => {
        s.set('badgeMap', badgeMap)
        s.set('unreadMap', unreadMap)
      })
    }
    case Chat2Gen.messageSetEditing:
      return state.update('editingMap', editingMap => {
        const {conversationIDKey, editLastUser, ordinal} = action.payload

        // clearing
        if (!editLastUser && !ordinal) {
          return editingMap.delete(conversationIDKey)
        }

        const messageMap = state.messageMap.get(conversationIDKey, I.Map())

        // editing a specific message
        if (ordinal) {
          const message = messageMap.get(ordinal)
          if (message && message.type === 'text') {
            return editingMap.set(conversationIDKey, ordinal)
          } else {
            return editingMap
          }
        }

        // Editing your last message
        const ordinals = state.messageOrdinals.get(conversationIDKey, I.SortedSet())
        const found = ordinals.findLast(o => {
          const message = messageMap.get(o)
          return message && message.type === 'text' && message.author === editLastUser
        })
        if (found) {
          return editingMap.set(conversationIDKey, found)
        }
        return editingMap
      })
    case Chat2Gen.messagesAdd: {
      const {messages, context} = action.payload

      // first group into convoid
      const convoToMessages: {[cid: string]: Array<Types.Message>} = messages.reduce((map, m) => {
        const key = String(m.conversationIDKey)
        map[key] = map[key] || []
        map[key].push(m)
        return map
      }, {})

      const canSendType = (m: Types.Message): ?Types.MessageText | ?Types.MessageAttachment =>
        m.type === 'text' || m.type === 'attachment' ? m : null

      const pendingOutboxToOrdinal = state.pendingOutboxToOrdinal.withMutations(
        (map: I.Map<Types.ConversationIDKey, I.Map<Types.OutboxID, Types.Ordinal>>) => {
          if (context.type !== 'sent' && context.type !== 'threadLoad') {
            return
          }

          messages.forEach(message => {
            const m = canSendType(message)
            if (m && !m.id && m.outboxID) {
              map.setIn([m.conversationIDKey, m.outboxID], m.ordinal)
            }
          })
        }
      )

      // TODO maybe move up
      const findExisting = (
        conversationIDKey: Types.ConversationIDKey,
        m: Types.MessageText | Types.MessageAttachment
      ) => {
        // something we sent
        if (m.outboxID) {
          // and we know about it
          const ordinal = state.pendingOutboxToOrdinal.getIn([conversationIDKey, m.outboxID])
          if (ordinal) {
            console.log('aaa find old', m.ordinal, ordinal)
            return state.messageMap.getIn([conversationIDKey, ordinal])
          }
        }
        const pendingOrdinal = messageIDToOrdinal(
          state.messageMap,
          state.pendingOutboxToOrdinal,
          conversationIDKey,
          m.id
        )
        if (pendingOrdinal) {
          console.log('aaa find old pending', m.ordinal, pendingOrdinal)
          return state.messageMap.getIn([conversationIDKey, pendingOrdinal])
        }
        console.log('aaa find old fail', m.ordinal)
        return null
      }

      const messageOrdinals = state.messageOrdinals.withMutations(
        (map: I.Map<Types.ConversationIDKey, I.SortedSet<Types.Ordinal>>) => {
          Object.keys(convoToMessages).forEach(cid => {
            const conversationIDKey = Types.stringToConversationIDKey(cid)
            const messages = convoToMessages[cid]
            const ordinals = messages.reduce((arr, message) => {
              const m = canSendType(message)
              if (m) {
                // Sendable so we might have an existing message
                if (!findExisting(conversationIDKey, m)) {
                  arr.push(m.ordinal)
                }
              } else {
                arr.push(message.ordinal)
              }
              return arr
            }, [])

            map.update(conversationIDKey, I.SortedSet(), (set: I.SortedSet<Types.Ordinal>) =>
              set.concat(ordinals)
            )
          })
        }
      )

      // TODO move up
      const upgradeMessage = (old: Types.Message, m: Types.Message) => {
        if (old.type === 'text' && m.type === 'text') {
          // $ForceType
          return m.withMutations((ret: Types.MessageText) => {
            ret.set('ordinal', old.ordinal)
          })
        }
        if (old.type === 'attachment' && m.type === 'attachment') {
          // $ForceType
          return m.withMutations((ret: Types.MessageAttachment) => {
            ret.set('ordinal', old.ordinal)
          })
        }
        return m
      }

      const messageMap = state.messageMap.withMutations(
        (map: I.Map<Types.ConversationIDKey, I.Map<Types.Ordinal, Types.Message>>) => {
          Object.keys(convoToMessages).forEach(cid => {
            const conversationIDKey = Types.stringToConversationIDKey(cid)
            const messages = convoToMessages[cid]
            messages.forEach(message => {
              const m = canSendType(message)
              const old = m ? findExisting(conversationIDKey, m) : null
              const toSet = old ? upgradeMessage(old, message) : message
              map.setIn([conversationIDKey, toSet.ordinal], toSet)
            })
          })
        }
      )

      // We're sending a message or loading a thread, add it to the map if its pending
      // if (context.type === 'sent' || context.type === 'threadLoad') {
      // pendingOutboxToOrdinal = pendingOutboxToOrdinal.withMutations(
      // (map: I.Map<Types.ConversationIDKey, I.Map<Types.OutboxID, Types.Ordinal>>) =>
      // maybePendingMessages.forEach(message => {
      // // no id and it has an outboxid is a new thing we're sending
      // if (!message.id && message.outboxID) {
      // map.setIn([message.conversationIDKey, message.outboxID], message.ordinal)
      // }
      // })
      // )
      // }
      // A lot of the complex stuff only happens on text and attachments so pull them out so its easier to flow type
      // const maybePendingMessages: Array<Types.MessageAttachment | Types.MessageText> = messages.reduce(
      // (arr, m) => {
      // if (m.type === 'text' || m.type === 'attachment') {
      // arr.push(m)
      // }
      // return arr
      // },
      // []
      // )
      // const notPendingMessages = messages.reduce((arr, m) => {
      // if (m.type !== 'text' && m.type !== 'attachment') {
      // arr.push(m)
      // }
      // return arr
      // }, [])

      // let pendingOutboxToOrdinal = state.pendingOutboxToOrdinal
      // We're sending a message or loading a thread, add it to the map if its pending
      // if (context.type === 'sent' || context.type === 'threadLoad') {
      // pendingOutboxToOrdinal = pendingOutboxToOrdinal.withMutations(
      // (map: I.Map<Types.ConversationIDKey, I.Map<Types.OutboxID, Types.Ordinal>>) =>
      // maybePendingMessages.forEach(message => {
      // // no id and it has an outboxid is a new thing we're sending
      // if (!message.id && message.outboxID) {
      // map.setIn([message.conversationIDKey, message.outboxID], message.ordinal)
      // }
      // })
      // )
      // }

      // // find any message that's associated with this one (pending, attachment, etc)
      // let old
      // if ()

      // const messageOrdinals = state.messageOrdinals.withMutations(
      // (map: I.Map<Types.ConversationIDKey, I.SortedSet<Types.Ordinal>>) => {
      // notPendingMessages.forEach(message => {
      // map.update(
      // Types.stringToConversationIDKey(message.conversationIDKey),
      // I.SortedSet(),
      // (set: I.SortedSet<Types.Ordinal>) => set.concat([message.ordinal])
      // )
      // })
      // maybePendingMessages.forEach(message => {
      // const conversationIDKey = message.conversationIDKey
      // let ordinal
      // // The outbox id is either directly on the message or on attachment upload we point to the message but don't have the
      // // outbox id directly so we see if we can get it from the existing placeholder
      // let outboxID = message.outboxID
      // if (!outboxID) {
      // const old = state.messageMap.getIn([conversationIDKey, message.ordinal])
      // if (old && (old.type === 'text' || old.type === 'attachment')) {
      // outboxID = old.outboxID
      // }
      // }
      // if (outboxID) {
      // ordinal = pendingOutboxToOrdinal.getIn([conversationIDKey, outboxID])
      // }
      // ordinal = ordinal || message.ordinal
      // map.update(
      // Types.stringToConversationIDKey(conversationIDKey),
      // I.SortedSet(),
      // (set: I.SortedSet<Types.Ordinal>) => set.concat([ordinal])
      // )
      // })
      // }
      // )

      // // Update messageMap. We allow multiple ids to map to the same object so any
      // // ordinal or resolved ordinal will work (2.001 and 3 will point to the same object after sending)
      // const messageMap = state.messageMap.withMutations(
      // (map: I.Map<Types.ConversationIDKey, I.Map<Types.Ordinal, Types.Message>>) => {
      // notPendingMessages.forEach(message => {
      // map.setIn([message.conversationIDKey, message.ordinal], message)
      // })
      // maybePendingMessages.forEach(message => {
      // const conversationIDKey = message.conversationIDKey

      // // Jump back through any related message to find the root
      // let rootMessage = message
      // const listOrdinals = state.messageOrdinals.get(conversationIDKey, I.OrderedSet())
      // while (true) {
      // if (!rootMessage) {
      // break
      // }
      // if (listOrdinals.has(rootMessage.ordinal)) {
      // break
      // }
      // rootMessage = state.messageMap.getIn([conversationIDKey, rootMessage.ordinal])
      // }

      // let outboxID: ?Types.OutboxID = message.outboxID
      // if (
      // !outboxID &&
      // rootMessage &&
      // (rootMessage.type === 'text' || rootMessage.type === 'attachment')
      // ) {
      // outboxID = rootMessage.outboxID
      // }
      // const pendingOrdinal = outboxID
      // ? pendingOutboxToOrdinal.getIn([conversationIDKey, outboxID])
      // : null
      // const old =
      // rootMessage &&
      // state.messageMap.getIn([conversationIDKey, pendingOrdinal || rootMessage.ordinal])

      // const ordinals: Set<Types.Ordinal> = new Set()
      // pendingOrdinal && ordinals.add(pendingOrdinal)
      // message.ordinal && ordinals.add(message.ordinal)
      // message.id && ordinals.add(Types.numberToOrdinal(message.id))

      // // Set the ordinal on the message itself to the pending one, if it exists
      // let updatedMessage = message
      // if (pendingOrdinal) {
      // // duped to help flow
      // if (updatedMessage.type === 'attachment') {
      // updatedMessage = updatedMessage.withMutations((m: Types.MessageAttachment) => {
      // m.set('ordinal', pendingOrdinal)
      // if (outboxID) {
      // m.set('outboxID', outboxID)
      // }
      // // keep some stuff from the old messages
      // if (old && old.type === 'attachment') {
      // !m.devicePreviewPath && m.set('devicePreviewPath', old.devicePreviewPath)
      // !m.previewWidth && m.set('previewWidth', old.previewWidth)
      // !m.previewHeight && m.set('previewHeight', old.previewHeight)
      // }
      // })
      // }
      // if (updatedMessage.type === 'text') {
      // updatedMessage = updatedMessage.withMutations((m: Types.MessageText) => {
      // m.set('ordinal', pendingOrdinal)
      // if (outboxID) {
      // m.set('outboxID', outboxID)
      // }
      // })
      // }
      // }

      // ordinals.forEach(ordinal => {
      // map.setIn([message.conversationIDKey, ordinal], updatedMessage)
      // })
      // })
      // }
      // )

      // Step 1. Grouping messages
      // const idToMessages = messages.reduce((map, m) => {
      // // If we have an ordinal for this already ignore it
      // const conversationIDKey = Types.conversationIDKeyToString(m.conversationIDKey)
      // const set = (map[conversationIDKey] = map[conversationIDKey] || new Set()) // note: NOT immutable
      // set.add(m.ordinal)
      // return map
      // }, {})

      //
      // Object.keys(idToMessages).forEach(conversationIDKey => {
      // const set = idToMessages[conversationIDKey]
      // set.forEach()

      // })

      // Create a map of conversationIDKey to Sorted list of ordinals
      // const messageOrdinals = state.messageOrdinals.withMutations(
      // (map: I.Map<Types.ConversationIDKey, I.SortedSet<Types.Ordinal>>) =>
      // Object.keys(idToMessages).forEach(conversationIDKey =>
      // map.update(
      // Types.stringToConversationIDKey(conversationIDKey),
      // I.SortedSet(),
      // (set: I.SortedSet<Types.Ordinal>) => set.concat(idToMessages[conversationIDKey])
      // )
      // )
      // )

      const metaMap =
        context.type === 'threadLoad' && state.metaMap.get(context.conversationIDKey)
          ? state.metaMap.update(context.conversationIDKey, (meta: Types.ConversationMeta) =>
              meta.set('hasLoadedThread', true)
            )
          : state.metaMap

      console.log(
        'aaa redu: metamap',
        metaMap.toJS(),
        '\nmessagemap',
        messageMap.toJS(),
        '\nmessageOrdinals',
        messageOrdinals.toJS(),
        '\npendingoutbox',
        pendingOutboxToOrdinal.toJS()
      )

      return state.withMutations(s => {
        s.set('metaMap', metaMap)
        s.set('messageMap', messageMap)
        s.set('messageOrdinals', messageOrdinals)
        s.set('pendingOutboxToOrdinal', pendingOutboxToOrdinal)
      })
    }
    case Chat2Gen.clearOrdinals: {
      return state.withMutations(s => {
        s.deleteIn(['messageOrdinals', action.payload.conversationIDKey])
        s.deleteIn(['pendingOutboxToOrdinal', action.payload.conversationIDKey])
        s.deleteIn(['messageMap', action.payload.conversationIDKey])
      })
    }
    case Chat2Gen.messageRetry: {
      const {conversationIDKey, outboxID} = action.payload
      const ordinal = state.pendingOutboxToOrdinal.getIn([conversationIDKey, outboxID])
      if (!ordinal) {
        return state
      }
      return state.set(
        'messageMap',
        state.messageMap.updateIn([conversationIDKey, ordinal], message => {
          if (message) {
            if (message.type === 'text') {
              return message.set('errorReason', null).set('submitState', 'pending')
            }
            if (message.type === 'attachment') {
              return message.set('errorReason', null).set('submitState', 'pending')
            }
          }
          return message
        })
      )
    }
    case Chat2Gen.messageErrored: {
      const {conversationIDKey, outboxID, reason} = action.payload
      const ordinal = state.pendingOutboxToOrdinal.getIn([conversationIDKey, outboxID])
      if (!ordinal) {
        return state
      }
      return state.set(
        'messageMap',
        state.messageMap.updateIn([conversationIDKey, ordinal], message => {
          if (message) {
            if (message.type === 'text') {
              return message.set('errorReason', reason).set('submitState', null)
            }
            if (message.type === 'attachment') {
              return message.set('errorReason', reason).set('submitState', null)
            }
          }
          return message
        })
      )
    }
    case Chat2Gen.clearPendingConversation: {
      return state.withMutations(s => {
        const conversationIDKey = Types.stringToConversationIDKey('')
        s.deleteIn(['messageOrdinals', conversationIDKey])
        s.deleteIn(['pendingOutboxToOrdinal', conversationIDKey])
        s.deleteIn(['messageMap', conversationIDKey])
      })
    }

    // metaMap/messageMap/messageOrdinalsList only actions
    case Chat2Gen.inboxRefresh:
    case Chat2Gen.messageDelete:
    case Chat2Gen.messageEdit:
    case Chat2Gen.messageWasEdited:
    case Chat2Gen.messagesWereDeleted:
    case Chat2Gen.metaReceivedError:
    case Chat2Gen.metaRequestingTrusted:
    case Chat2Gen.metasReceived:
    case Chat2Gen.attachmentLoading:
    case Chat2Gen.attachmentLoaded:
    case Chat2Gen.attachmentDownloaded:
      return state.withMutations(s => {
        s.set('metaMap', metaMapReducer(state.metaMap, action))
        s.set('messageMap', messageMapReducer(state.messageMap, action, state.pendingOutboxToOrdinal))
        s.set('messageOrdinals', messageOrdinalsReducer(state.messageOrdinals, action))
      })
    // Saga only actions
    case Chat2Gen.desktopNotification:
    case Chat2Gen.joinConversation:
    case Chat2Gen.leaveConversation:
    case Chat2Gen.loadMoreMessages:
    case Chat2Gen.messageSend:
    case Chat2Gen.metaHandleQueue:
    case Chat2Gen.metaNeedsUpdating:
    case Chat2Gen.metaRequestTrusted:
    case Chat2Gen.muteConversation:
    case Chat2Gen.openFolder:
    case Chat2Gen.resetChatWithoutThem:
    case Chat2Gen.resetLetThemIn:
    case Chat2Gen.setupChatHandlers:
    case Chat2Gen.startConversation:
    case Chat2Gen.exitSearch:
    case Chat2Gen.sendToPendingConversation:
    case Chat2Gen.attachmentNeedsUpdating:
    case Chat2Gen.attachmentHandleQueue:
    case Chat2Gen.attachmentLoad:
    case Chat2Gen.attachmentDownload:
    case Chat2Gen.attachmentUpload:
    case Chat2Gen.attachmentUploading:
      return state
    default:
      // eslint-disable-next-line no-unused-expressions
      ;(action: empty) // if you get a flow error here it means there's an action you claim to handle but didn't
      return state
  }
}

export default rootReducer