import { I18N } from '@common/I18N';
import { Session } from '@common/Session';
import { Shared } from '@common/Shared';
import { Center } from '@components/Center';
import { useHistory } from '@contexts/HistoryContext';
import { Button, CircularProgress, Typography } from '@mui/material';
import { useEffect, useState } from 'react';

export const LoginPage = (): JSX.Element => {
	const history = useHistory();
	const [isLoading, setLoading] = useState(true);

	const onLoginClick = async (): Promise<void> => {
		setLoading(true);
		await Session.login();
	};

	const onSkipClick = () => {
		history.push('/home');
	};

	useEffect(() => {
		const startListeners = () => {
			Shared.events.subscribe('LOGIN_SUCCESS', null, onLoginSuccess);
			Shared.events.subscribe('LOGIN_ERROR', null, onLoginError);
		};

		const stopListeners = () => {
			Shared.events.unsubscribe('LOGIN_SUCCESS', null, onLoginSuccess);
			Shared.events.unsubscribe('LOGIN_ERROR', null, onLoginError);
		};

		const onLoginSuccess = () => {
			setLoading(false);
			if (Shared.redirectPath) {
				history.push(Shared.redirectPath);
			} else {
				history.push('/home');
			}
		};

		const onLoginError = () => {
			setLoading(false);
		};

		startListeners();
		return stopListeners;
	}, []);

	useEffect(() => {
		const init = async () => {
			await Session.checkLogin();
		};

		void init();
	}, []);

	const { scrobUrl, scrobApiKey } = Shared.storage.options;
	const hasScrob = !!(scrobUrl && scrobApiKey);

	return (
		<Center>
			{isLoading ? (
				<CircularProgress color="secondary" />
			) : (
				<>
					<Button color="secondary" onClick={() => void onLoginClick()} variant="contained">
						{I18N.translate('login')}
					</Button>
					{hasScrob && (
						<>
							<Typography color="text.secondary" sx={{ mt: 1 }}>
								{I18N.translate('scrobConfiguredMessage')}
							</Typography>
							<Button color="primary" onClick={onSkipClick} variant="text" sx={{ mt: 1 }}>
								{I18N.translate('skipToHome')}
							</Button>
						</>
					)}
				</>
			)}
		</Center>
	);
};
