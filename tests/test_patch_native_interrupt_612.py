"""Verify the 6.1.12 patch only acknowledges settled, idempotent cleanup."""

import importlib.util
import json
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('native_interrupt_patch', ROOT / 'bin/patch-native-interrupt-612.py')
PATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCH)


class NativeInterruptPatchTests(unittest.TestCase):
    def test_exact_vendor_anchors_and_idempotence(self):
        vendor = (PATCH.MAP_FROM + PATCH.HEALTH_FROM + PATCH.INTERRUPT_FROM)
        updated = PATCH.patch_content(vendor)
        self.assertIn('scoped_interrupt_settled:!0', updated)
        self.assertIn('__ompScopedInterruptSettlements', updated)
        self.assertEqual(PATCH.patch_content(updated), updated)
        with self.assertRaises(ValueError):
            PATCH.patch_content('unexpected vendor version')

    def test_scoped_interrupt_waits_for_settlement_and_deduplicates_retries(self):
        source = '''
let __ompScopedInterruptSettlements=new Map;
let initiated=0,resolveCleanup;
let wait=new Promise(resolve=>resolveCleanup=resolve);
let shouldReject=false;
let He={cancelNativeTurn:()=>{initiated++;return {cancelled:1,settlement:shouldReject?Promise.reject(Error("cleanup failed")):wait}}};
let Hf=()=>({cancelled:0,settlement:Promise.resolve()});
let u={beginCancelTurn:()=>({cancelled:1,settlement:Promise.resolve()})};
async function interrupt(f){%s}
let identity={threadId:"native_thread_a",turnId:"native_turn_a"};
let first=interrupt(identity),second=interrupt(identity);
if(initiated!==1)throw Error("Duplicate cancellation started");
let pending=await Promise.race([first.then(()=>false),Promise.resolve(true)]);
if(!pending)throw Error("ACK arrived before retirement settled");
resolveCleanup();
let [firstAck,secondAck]=await Promise.all([first,second]);
if(firstAck.status!==200||secondAck.status!==200||initiated!==1)throw Error("Invalid idempotent ACK");
let retry=await interrupt(identity);
if(retry.status!==200||initiated!==2)throw Error("Settled identity was not safely released");
if(__ompScopedInterruptSettlements.size!==0)throw Error("Settled cancellation cache leaked");
shouldReject=true;
let bad=await interrupt({threadId:"native_thread_b",turnId:"native_turn_b"});
if(bad.status!==503)throw Error("Failure was falsely acknowledged");
if(__ompScopedInterruptSettlements.size!==0)throw Error("Failed cancellation cache leaked");
console.log(JSON.stringify({ok:true}));
''' % PATCH.INTERRUPT_TO
        result = subprocess.run(['node', '--input-type=module', '-e', source],
                                capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), {'ok': True})


if __name__ == '__main__':
    unittest.main()
