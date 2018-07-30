// @flow
import * as React from 'react'
import * as Types from '../../../../../constants/types/chat2'
import {Box, Box2, Icon, iconCastPlatformStyles} from '../../../../../common-adapters'
import {
  FloatingMenuParentHOC,
  type FloatingMenuParentProps,
} from '../../../../../common-adapters/floating-menu'
import Timestamp from '../timestamp'
import {
  glamorous,
  globalMargins,
  globalStyles,
  globalColors,
  isMobile,
  platformStyles,
  styleSheetCreate,
} from '../../../../../styles'
import ReactionsRow from '../../reactions-row/container'
import ReactButton from '../../react-button/container'
import MessagePopup from '../../message-popup'
import ExplodingMeta from '../exploding-meta/container'
import type {WrapperTimestampProps} from '../index.types'

const HoverBox = isMobile
  ? Box
  : glamorous(Box)({
      '& .menu-button': {
        flexShrink: 0,
        height: 17,
        opacity: 0,
        visibility: 'hidden',
      },
      '&:hover': {
        backgroundColor: globalColors.blue4,
      },
      '&:hover .menu-button': {
        opacity: 1,
        visibility: 'visible',
      },
      flexDirection: 'column',
    })

class WrapperTimestamp extends React.PureComponent<WrapperTimestampProps> {
  componentDidUpdate(prevProps: WrapperTimestampProps) {
    if (this.props.measure) {
      if (
        this.props.orangeLineAbove !== prevProps.orangeLineAbove ||
        this.props.timestamp !== prevProps.timestamp
      ) {
        this.props.measure()
      }
    }
  }
  render() {
    const props = this.props
    return (
      <Box style={styles.container}>
        {props.orangeLineAbove && <Box style={styles.orangeLine} />}
        {props.timestamp && <Timestamp timestamp={props.timestamp} />}
        <HoverBox>
          <Box2 direction="horizontal">
            {props.children}
            {!isMobile &&
              !props.exploded && (
                <MenuButtons
                  conversationIDKey={props.conversationIDKey}
                  message={props.message}
                  ordinal={props.ordinal}
                />
              )}
          </Box2>
          <ReactionsRow conversationIDKey={props.conversationIDKey} ordinal={props.ordinal} />
        </HoverBox>
      </Box>
    )
  }
}

type MenuButtonsProps = {
  conversationIDKey: Types.ConversationIDKey,
  message: Types.Message,
  ordinal: Types.Ordinal,
} & FloatingMenuParentProps
const _MenuButtons = (props: MenuButtonsProps) => (
  <Box2 direction="vertical" style={styles.controls}>
    <Box className="menu-button" style={styles.menuButtons}>
      <ReactButton
        conversationIDKey={props.conversationIDKey}
        ordinal={props.ordinal}
        showBorder={false}
        tooltipEnabled={false}
      />
      <Box ref={props.setAttachmentRef}>
        {(props.message.type === 'attachment' || props.message.type === 'text') && (
          <Icon type="iconfont-ellipsis" onClick={props.toggleShowingMenu} fontSize={16} />
        )}
      </Box>
      {(props.message.type === 'attachment' || props.message.type === 'text') && (
        <MessagePopup
          attachTo={props.attachmentRef}
          message={props.message}
          onHidden={props.toggleShowingMenu}
          position="top center"
          visible={props.showingMenu}
        />
      )}
    </Box>
    <ExplodingMeta
      conversationIDKey={props.conversationIDKey}
      onClick={props.toggleShowingMenu}
      ordinal={props.ordinal}
    />
  </Box2>
)
const MenuButtons = FloatingMenuParentHOC(_MenuButtons)

const styles = styleSheetCreate({
  container: {...globalStyles.flexBoxColumn, width: '100%'},
  controls: platformStyles({
    isElectron: {
      flexBasis: 120,
      flexShrink: 1,
      flexWrap: 'wrap',
      justifyContent: 'space-between',
    },
  }),
  menuButtons: platformStyles({
    isElectron: {
      ...globalStyles.flexBoxRow,
      alignItems: 'center',
      alignSelf: 'flex-start',
      position: 'relative',
      top: 1,
    },
  }),
  orangeLine: {backgroundColor: globalColors.orange, height: 1, width: '100%'},
})

export default WrapperTimestamp
