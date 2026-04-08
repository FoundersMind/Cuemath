web: python manage.py migrate --noinput && python manage.py collectstatic --noinput && gunicorn cuemath_screener.wsgi:application --bind 0.0.0.0:$PORT
