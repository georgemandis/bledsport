// espeak-ng audio test — run: bun test-audio.js
const { execFile, execFileSync } = require('child_process');

// Check if espeak-ng exists
try {
  const path = execFileSync('which', ['espeak-ng']).toString().trim();
  console.log('espeak-ng found at:', path);
} catch {
  console.error('espeak-ng NOT FOUND — install it with:');
  console.error('  sudo apt install espeak-ng   (Debian/Ubuntu/Pi)');
  console.error('  brew install espeak-ng        (macOS)');
  process.exit(1);
}

// Check version
try {
  const version = execFileSync('espeak-ng', ['--version']).toString().trim();
  console.log('Version:', version);
} catch (e) {
  console.error('Failed to get version:', e.message);
}

// List available voices
try {
  const voices = execFileSync('espeak-ng', ['--voices=en']).toString().trim().split('\n').slice(0, 5);
  console.log('\nAvailable English voices (first 5):');
  voices.forEach(v => console.log(' ', v));
} catch (e) {
  console.error('Failed to list voices:', e.message);
}

// Test sequence
const tests = [
  { label: 'Basic test', args: ['hello world'] },
  { label: 'Low pitch, slow', args: ['-p', '20', '-s', '120', 'low and slow'] },
  { label: 'High pitch, fast', args: ['-p', '90', '-s', '220', 'high and fast'] },
  { label: 'Male variant 1', args: ['-v', 'en+m1', 'variant one'] },
  { label: 'Male variant 3', args: ['-v', 'en+m3', 'variant three'] },
  { label: 'Game: fight', args: ['-p', '50', '-s', '150', 'fight'] },
  { label: 'Game: kaboom', args: ['-p', '30', '-s', '140', 'kaboom'] },
  { label: 'Game: player one, wasted', args: ['-p', '60', '-s', '170', '-v', 'en+m2', 'player one, wasted'] },
  { label: 'Game: player two wins', args: ['-p', '40', '-s', '160', '-v', 'en+m4', 'player two wins'] },
];

async function runTests() {
  for (const test of tests) {
    console.log(`\nTesting: ${test.label}`);
    console.log(`  espeak-ng ${test.args.join(' ')}`);

    await new Promise((resolve) => {
      execFile('espeak-ng', test.args, (err, stdout, stderr) => {
        if (err) {
          console.error(`  ERROR: ${err.message}`);
          if (stderr) console.error(`  stderr: ${stderr}`);
        } else {
          console.log('  OK');
          if (stderr) console.log(`  stderr: ${stderr}`);
        }
        resolve();
      });
    });

    // Brief pause between tests
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log('\nAll tests complete.');
}

runTests();
