import axios from 'axios';
try {
  const res = await axios.get('http://localhost:3000');
  console.log('Server is reachable!', res.status);
} catch (err) {
  console.error('Server is not reachable:', err.message);
}