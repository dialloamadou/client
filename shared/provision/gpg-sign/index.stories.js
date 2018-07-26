// @flow
import * as React from 'react'
import {Text} from '../../common-adapters'
import {storiesOf} from '../../stories/storybook'

const load = () => {
  storiesOf('Provision/GPGSign', module).add('GPGSign', () => <Text type="Body">TODO</Text>)
}

export default load
