from django.urls import re_path

from api import views

urlpatterns = [
    re_path(r"^(?P<path>.*)$", views.serve_public),
]
