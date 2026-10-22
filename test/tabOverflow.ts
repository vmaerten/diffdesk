import { splitTabs } from '../web/src/tabOverflow.ts'
import type { Check } from './harness.ts'

const split = (count: number, active: number, width: number) =>
  JSON.stringify(splitTabs(count, active, width))

export async function runTabOverflow(check: Check): Promise<void> {
  check('every tab fits', split(3, 0, 1000) === '{"shown":[0,1,2],"hidden":[]}')
  check(
    'the overflow keeps the first tabs',
    split(6, 1, 400) === '{"shown":[0,1,2],"hidden":[3,4,5]}',
  )
  check(
    'the active tab stays in the bar',
    split(6, 5, 400) === '{"shown":[0,1,5],"hidden":[2,3,4]}',
  )
  check(
    'a narrow bar still shows the active tab',
    split(4, 3, 50) === '{"shown":[3],"hidden":[0,1,2]}',
  )
}
