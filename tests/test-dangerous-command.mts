/**
 * isDangerousCommand: the audit tag that decides whether an agent command
 * gets a pre-flight snapshot. False negatives lose forensics; false positives
 * take a snapshot of an innocent command. Both directions are tested.
 *
 *   npx esbuild tests/test-dangerous-command.mts --bundle --platform=node \
 *     --format=cjs --outfile=tests/.tmp-dangerous-command.cjs
 *   node tests/.tmp-dangerous-command.cjs
 */
import { isDangerousCommand } from '../src/main/util'

const results: Array<[string, boolean, unknown]> = []
const check = (name: string, ok: boolean, detail?: unknown): void => {
  results.push([name, ok, detail])
}

const dangerous: string[] = [
  'rm -rf /',
  'rm -rf / ',
  'rm -r -f /',
  'rm -fr /',
  'rm -Rf /',
  'rm --recursive /',
  'rm -rf /*',
  'rm -rf "/"',
  'sudo rm -rf /',
  'cd /tmp && rm -rf /',
  '/bin/rm -rf /',
  'mkfs.ext4 /dev/sda1',
  'mkfs -t ext4 /dev/sda1',
  'dd if=/dev/zero of=/dev/sda bs=1M',
  'shutdown -h now',
  'sudo shutdown -h now',
  'reboot',
  'cd / && reboot',
  'poweroff',
  'halt',
  'systemctl reboot',
  'systemctl poweroff',
  ':(){ :|:& };:',
  'chmod -R 777 /',
  'chmod -r 777 /',
  'chown -R root /',
  'echo start; sudo reboot now'
]

for (const command of dangerous) {
  check(`dangerous: ${command}`, isDangerousCommand(command) === true)
}

const safe: string[] = [
  'ls -la /',
  'rm -rf /tmp/build',
  'rm -rf /home/demo/project/',
  'rm -rf ./node_modules',
  'rm -f notes.txt',
  'rm -r logs',
  'rm -f /',
  'mkdir -p /var/log/app',
  'dd if=/dev/sda of=/tmp/disk.img',
  'grep reboot /var/log/messages',
  'grep -r halt /etc/systemd',
  'echo reboot scheduled',
  'systemctl status nginx',
  'chmod -R 755 /var/www',
  'chmod 777 file.txt',
  'chown -R www-data /var/www',
  'cat /proc/meminfo',
  'printf "%s\\n" "$(uname -sr 2>/dev/null)"'
]

for (const command of safe) {
  const result = isDangerousCommand(command)
  check(`safe: ${command}`, result === false, result)
}

let failed = 0
for (const [name, pass, detail] of results) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`)
  if (!pass) {
    failed += 1
    console.log('      ', JSON.stringify(detail))
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
