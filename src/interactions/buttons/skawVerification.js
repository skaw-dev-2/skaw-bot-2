import { handleVerificationButton } from '../../services/skawVerificationService.js';

export default [
  {
    name: 'skaw_vf_register',
    async execute(interaction, client) {
      return handleVerificationButton(interaction, client, 'register');
    },
  },
  {
    name: 'skaw_vf_guide',
    async execute(interaction, client) {
      return handleVerificationButton(interaction, client, 'guide');
    },
  },
];
